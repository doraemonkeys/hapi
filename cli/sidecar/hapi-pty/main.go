package main

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

const (
	defaultStdinIdleTimeout = 120 * time.Second
	maxScannerTokenBytes    = 1024 * 1024
)

type runConfig struct {
	IdleTimeout    time.Duration
	LookPath       shellLookupFunc
	ProbeConPTY    func() error
	TerminalOpener terminalFactory
}

type scannerMessage struct {
	Line []byte
	Done bool
	Err  error
}

func main() {
	os.Exit(runSidecar(os.Stdin, os.Stdout, runConfig{}))
}

func runSidecar(stdin io.Reader, stdout io.Writer, cfg runConfig) int {
	if cfg.IdleTimeout <= 0 {
		cfg.IdleTimeout = defaultStdinIdleTimeout
	}
	if cfg.ProbeConPTY == nil {
		cfg.ProbeConPTY = probeConPTY
	}
	if cfg.TerminalOpener == nil {
		cfg.TerminalOpener = newPlatformTerminalSession
	}

	writer := &safeWriter{writer: stdout}
	emit := func(payload any) {
		_ = writer.Emit(payload)
	}
	emitError := func(terminalID string, code string, message string) {
		emit(errorEvent{
			Type:       eventTypeError,
			TerminalID: terminalID,
			Code:       code,
			Message:    message,
		})
	}

	emit(helloEvent{
		Type:     eventTypeHello,
		Version:  sidecarVersion,
		Protocol: protocolVersion,
	})

	conPTYAvailable := true
	conPTYErrorMessage := ""
	if err := cfg.ProbeConPTY(); err != nil {
		conPTYAvailable = false
		conPTYErrorMessage = err.Error()
	}

	terminals := map[string]terminalSession{}
	var terminalsMu sync.Mutex

	closeAllTerminals := func() {
		terminalsMu.Lock()
		sessions := make([]terminalSession, 0, len(terminals))
		for terminalID, session := range terminals {
			delete(terminals, terminalID)
			sessions = append(sessions, session)
		}
		terminalsMu.Unlock()

		for _, session := range sessions {
			_ = session.Close()
		}
	}

	runIsolated := func(terminalID string, task func()) {
		runIsolatedTerminalTask(terminalID, emitError, task)
	}

	lines := startScanner(stdin)
	idleTimer := time.NewTimer(cfg.IdleTimeout)
	defer idleTimer.Stop()

	for {
		select {
		case <-idleTimer.C:
			closeAllTerminals()
			return 2
		case msg, ok := <-lines:
			if !ok {
				closeAllTerminals()
				return 1
			}
			if msg.Done {
				closeAllTerminals()
				return 1
			}

			resetTimer(idleTimer, cfg.IdleTimeout)

			req, err := decodeRequestLine(msg.Line)
			if err != nil {
				emitError("", errorCodeUnknown, err.Error())
				continue
			}

			switch typed := req.(type) {
			case openRequest:
				if typed.TerminalID == "" {
					emitError("", errorCodeUnknown, "open request requires terminalId")
					continue
				}

				if !conPTYAvailable {
					emitError(typed.TerminalID, errorCodeConPTYUnavailable, conPTYErrorMessage)
					continue
				}

				shell, err := resolveShell(typed.Shell, cfg.LookPath)
				if err != nil {
					serr := sidecarErrorFrom(err, errorCodeShellNotFound)
					emitError(typed.TerminalID, serr.Code, serr.Message)
					continue
				}

				terminalsMu.Lock()
				_, exists := terminals[typed.TerminalID]
				terminalsMu.Unlock()
				if exists {
					emitError(typed.TerminalID, errorCodeStartupFailed, "terminal already exists")
					continue
				}

				terminalID := typed.TerminalID
				callbacks := terminalCallbacks{
					Output: func(chunk []byte) {
						emit(outputEvent{
							Type:       eventTypeOutput,
							TerminalID: terminalID,
							Data:       base64.StdEncoding.EncodeToString(chunk),
						})
					},
					Exit: func(code int) {
						terminalsMu.Lock()
						delete(terminals, terminalID)
						terminalsMu.Unlock()
						emit(exitEvent{
							Type:       eventTypeExit,
							TerminalID: terminalID,
							Code:       code,
						})
					},
				}

				session, err := cfg.TerminalOpener(typed, shell, callbacks, runIsolated)
				if err != nil {
					serr := sidecarErrorFrom(err, errorCodeStartupFailed)
					emitError(typed.TerminalID, serr.Code, serr.Message)
					continue
				}

				terminalsMu.Lock()
				terminals[terminalID] = session
				terminalsMu.Unlock()

				emit(readyEvent{
					Type:       eventTypeReady,
					TerminalID: terminalID,
					Display:    shell.Name,
				})

			case writeRequest:
				terminalsMu.Lock()
				session, exists := terminals[typed.TerminalID]
				terminalsMu.Unlock()
				if !exists {
					emitError(typed.TerminalID, errorCodeTerminalNotFound, "terminal not found")
					continue
				}

				if err := session.Write(typed.Data); err != nil {
					serr := sidecarErrorFrom(err, errorCodeStartupFailed)
					emitError(typed.TerminalID, serr.Code, serr.Message)
				}

			case resizeRequest:
				terminalsMu.Lock()
				session, exists := terminals[typed.TerminalID]
				terminalsMu.Unlock()
				if !exists {
					emitError(typed.TerminalID, errorCodeTerminalNotFound, "terminal not found")
					continue
				}

				if err := session.Resize(typed.Cols, typed.Rows); err != nil {
					serr := sidecarErrorFrom(err, errorCodeStartupFailed)
					emitError(typed.TerminalID, serr.Code, serr.Message)
				}

			case closeRequest:
				terminalsMu.Lock()
				session, exists := terminals[typed.TerminalID]
				if exists {
					delete(terminals, typed.TerminalID)
				}
				terminalsMu.Unlock()

				if exists {
					_ = session.Close()
				}

			case pingRequest:
				emit(pongEvent{Type: eventTypePong})

			case shutdownRequest:
				closeAllTerminals()
				emit(shutdownAckEvent{Type: eventTypeShutdownAck})
				return 0
			}
		}
	}
}

func runIsolatedTerminalTask(
	terminalID string,
	emitError func(terminalID string, code string, message string),
	task func(),
) {
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				emitError(
					terminalID,
					errorCodeSpawnFailed,
					fmt.Sprintf("terminal panic recovered: %v", recovered),
				)
			}
		}()
		task()
	}()
}

func startScanner(reader io.Reader) <-chan scannerMessage {
	out := make(chan scannerMessage, 32)
	go func() {
		defer close(out)

		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 0, 4096), maxScannerTokenBytes)

		for scanner.Scan() {
			line := append([]byte(nil), scanner.Bytes()...)
			out <- scannerMessage{Line: line}
		}

		out <- scannerMessage{
			Done: true,
			Err:  scanner.Err(),
		}
	}()

	return out
}

func resetTimer(timer *time.Timer, timeout time.Duration) {
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
	timer.Reset(timeout)
}

type safeWriter struct {
	writer io.Writer
	mu     sync.Mutex
}

func (w *safeWriter) Emit(payload any) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return writeNDJSONLine(w.writer, payload)
}
