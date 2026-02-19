package main

import (
	"encoding/json"
	"fmt"
	"io"
)

const (
	sidecarVersion  = "1.0.0"
	protocolVersion = 1
)

const (
	requestTypeOpen     = "open"
	requestTypeWrite    = "write"
	requestTypeResize   = "resize"
	requestTypeClose    = "close"
	requestTypePing     = "ping"
	requestTypeShutdown = "shutdown"
)

const (
	eventTypeHello       = "hello"
	eventTypeReady       = "ready"
	eventTypeOutput      = "output"
	eventTypeExit        = "exit"
	eventTypeError       = "error"
	eventTypePong        = "pong"
	eventTypeShutdownAck = "shutdown_ack"
)

const (
	errorCodeConPTYUnavailable = "conpty_unavailable"
	errorCodeShellNotFound     = "shell_not_found"
	errorCodeSpawnFailed       = "spawn_failed"
	errorCodeStartupFailed     = "startup_failed"
	errorCodeTerminalNotFound  = "terminal_not_found"
	errorCodeUnknown           = "unknown"
)

type request interface {
	requestType() string
}

type requestEnvelope struct {
	Type string `json:"type"`
}

type openRequest struct {
	Type       string            `json:"type"`
	TerminalID string            `json:"terminalId"`
	Cwd        string            `json:"cwd"`
	Shell      string            `json:"shell,omitempty"`
	Cols       int               `json:"cols"`
	Rows       int               `json:"rows"`
	Env        map[string]string `json:"env,omitempty"`
}

func (r openRequest) requestType() string { return r.Type }

type writeRequest struct {
	Type       string `json:"type"`
	TerminalID string `json:"terminalId"`
	Data       string `json:"data"`
}

func (r writeRequest) requestType() string { return r.Type }

type resizeRequest struct {
	Type       string `json:"type"`
	TerminalID string `json:"terminalId"`
	Cols       int    `json:"cols"`
	Rows       int    `json:"rows"`
}

func (r resizeRequest) requestType() string { return r.Type }

type closeRequest struct {
	Type       string `json:"type"`
	TerminalID string `json:"terminalId"`
}

func (r closeRequest) requestType() string { return r.Type }

type pingRequest struct {
	Type string `json:"type"`
}

func (r pingRequest) requestType() string { return r.Type }

type shutdownRequest struct {
	Type string `json:"type"`
}

func (r shutdownRequest) requestType() string { return r.Type }

type helloEvent struct {
	Type     string `json:"type"`
	Version  string `json:"version"`
	Protocol int    `json:"protocol"`
}

type readyEvent struct {
	Type       string `json:"type"`
	TerminalID string `json:"terminalId"`
	Display    string `json:"displayName"`
}

type outputEvent struct {
	Type       string `json:"type"`
	TerminalID string `json:"terminalId"`
	Data       string `json:"data"`
}

type exitEvent struct {
	Type       string `json:"type"`
	TerminalID string `json:"terminalId"`
	Code       int    `json:"code"`
}

type errorEvent struct {
	Type       string `json:"type"`
	TerminalID string `json:"terminalId,omitempty"`
	Code       string `json:"code"`
	Message    string `json:"message"`
}

type pongEvent struct {
	Type string `json:"type"`
}

type shutdownAckEvent struct {
	Type string `json:"type"`
}

type sidecarError struct {
	Code    string
	Message string
}

func (e *sidecarError) Error() string {
	return e.Message
}

func newSidecarError(code string, format string, args ...any) *sidecarError {
	return &sidecarError{
		Code:    code,
		Message: fmt.Sprintf(format, args...),
	}
}

func decodeRequestLine(line []byte) (request, error) {
	var env requestEnvelope
	if err := json.Unmarshal(line, &env); err != nil {
		return nil, fmt.Errorf("invalid request JSON: %w", err)
	}

	switch env.Type {
	case requestTypeOpen:
		var req openRequest
		if err := json.Unmarshal(line, &req); err != nil {
			return nil, fmt.Errorf("invalid open request: %w", err)
		}
		return req, nil
	case requestTypeWrite:
		var req writeRequest
		if err := json.Unmarshal(line, &req); err != nil {
			return nil, fmt.Errorf("invalid write request: %w", err)
		}
		return req, nil
	case requestTypeResize:
		var req resizeRequest
		if err := json.Unmarshal(line, &req); err != nil {
			return nil, fmt.Errorf("invalid resize request: %w", err)
		}
		return req, nil
	case requestTypeClose:
		var req closeRequest
		if err := json.Unmarshal(line, &req); err != nil {
			return nil, fmt.Errorf("invalid close request: %w", err)
		}
		return req, nil
	case requestTypePing:
		var req pingRequest
		if err := json.Unmarshal(line, &req); err != nil {
			return nil, fmt.Errorf("invalid ping request: %w", err)
		}
		return req, nil
	case requestTypeShutdown:
		var req shutdownRequest
		if err := json.Unmarshal(line, &req); err != nil {
			return nil, fmt.Errorf("invalid shutdown request: %w", err)
		}
		return req, nil
	default:
		return nil, fmt.Errorf("unknown request type %q", env.Type)
	}
}

func writeNDJSONLine(w io.Writer, payload any) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	encoded = append(encoded, '\n')
	_, err = w.Write(encoded)
	return err
}
