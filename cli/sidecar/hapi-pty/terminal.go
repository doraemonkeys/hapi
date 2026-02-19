package main

import (
	"errors"
	"io"
	"os/exec"
	"strings"
)

type terminalCallbacks struct {
	Output func([]byte)
	Exit   func(int)
}

type terminalSession interface {
	Write(data string) error
	Resize(cols int, rows int) error
	Close() error
}

type terminalFactory func(
	req openRequest,
	shell resolvedShell,
	callbacks terminalCallbacks,
	runIsolated func(terminalID string, task func()),
) (terminalSession, error)

func streamOutput(reader io.Reader, emit func([]byte)) {
	if emit == nil {
		return
	}

	buffer := make([]byte, 4096)
	for {
		n, err := reader.Read(buffer)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buffer[:n])
			emit(chunk)
		}

		if err == nil {
			continue
		}

		if errors.Is(err, io.EOF) {
			return
		}

		return
	}
}

func exitCodeFrom(err error) int {
	if err == nil {
		return 0
	}

	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}

	return -1
}

func mergeEnvironment(base []string, overrides map[string]string) []string {
	if len(overrides) == 0 {
		return append([]string(nil), base...)
	}

	merged := append([]string(nil), base...)
	for key, value := range overrides {
		prefix := key + "="
		replaced := false

		for idx, item := range merged {
			if strings.HasPrefix(item, prefix) {
				merged[idx] = prefix + value
				replaced = true
				break
			}
		}

		if !replaced {
			merged = append(merged, prefix+value)
		}
	}

	return merged
}
