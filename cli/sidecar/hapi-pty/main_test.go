package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRunSidecarEmitsHelloPongAndShutdownAck(t *testing.T) {
	stdin := strings.NewReader(
		`{"type":"ping"}` + "\n" +
			`{"type":"shutdown"}` + "\n",
	)
	var stdout bytes.Buffer

	exitCode := runSidecar(stdin, &stdout, runConfig{
		IdleTimeout: 2 * time.Second,
		ProbeConPTY: func() error { return nil },
	})
	if exitCode != 0 {
		t.Fatalf("expected graceful shutdown exit code 0, got %d", exitCode)
	}

	events := decodeRawEvents(t, &stdout)
	if len(events) < 3 {
		t.Fatalf("expected at least 3 events, got %d", len(events))
	}

	if events[0]["type"] != eventTypeHello {
		t.Fatalf("first event should be hello, got %#v", events[0])
	}
	if int(events[0]["protocol"].(float64)) != protocolVersion {
		t.Fatalf("unexpected protocol version: %#v", events[0]["protocol"])
	}

	assertEventType(t, events, eventTypePong)
	assertEventType(t, events, eventTypeShutdownAck)
}

func TestRunSidecarIdleTimeoutExitCode(t *testing.T) {
	reader, writer := io.Pipe()
	defer writer.Close()

	var stdout bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- runSidecar(reader, &stdout, runConfig{
			IdleTimeout: 40 * time.Millisecond,
			ProbeConPTY: func() error { return nil },
		})
	}()

	select {
	case exitCode := <-done:
		if exitCode != 2 {
			t.Fatalf("expected idle-timeout exit code 2, got %d", exitCode)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("sidecar did not exit from idle timeout")
	}
}

func TestRunIsolatedTerminalTaskPanicIsolation(t *testing.T) {
	errorCh := make(chan errorEvent, 2)
	okCh := make(chan struct{}, 1)
	var wg sync.WaitGroup
	wg.Add(2)

	emitError := func(terminalID string, code string, message string) {
		errorCh <- errorEvent{
			Type:       eventTypeError,
			TerminalID: terminalID,
			Code:       code,
			Message:    message,
		}
	}

	runIsolatedTerminalTask("panic-term", emitError, func() {
		defer wg.Done()
		panic("boom")
	})
	runIsolatedTerminalTask("ok-term", emitError, func() {
		defer wg.Done()
		okCh <- struct{}{}
	})

	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("isolated tasks did not complete")
	}

	select {
	case <-okCh:
	default:
		t.Fatal("non-panicking task was not executed")
	}

	select {
	case evt := <-errorCh:
		if evt.TerminalID != "panic-term" {
			t.Fatalf("panic event terminal mismatch: %+v", evt)
		}
		if evt.Code != errorCodeSpawnFailed {
			t.Fatalf("panic event code mismatch: %+v", evt)
		}
		if !strings.Contains(evt.Message, "boom") {
			t.Fatalf("panic event should include panic reason: %+v", evt)
		}
	case <-time.After(time.Second):
		t.Fatal("panic isolation did not emit terminal error event")
	}
}

func decodeRawEvents(t *testing.T, stdout *bytes.Buffer) []map[string]any {
	t.Helper()

	events := make([]map[string]any, 0)
	scanner := bufio.NewScanner(bytes.NewReader(stdout.Bytes()))
	for scanner.Scan() {
		raw := scanner.Bytes()
		payload := map[string]any{}
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatalf("failed to decode event %q: %v", string(raw), err)
		}
		events = append(events, payload)
	}

	if err := scanner.Err(); err != nil {
		t.Fatalf("failed scanning events: %v", err)
	}

	return events
}

func assertEventType(t *testing.T, events []map[string]any, eventType string) {
	t.Helper()

	for _, evt := range events {
		if evt["type"] == eventType {
			return
		}
	}

	t.Fatalf("event %q not found in %#v", eventType, events)
}
