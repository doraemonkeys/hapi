//go:build !windows

package main

import (
	"errors"
	"testing"
)

func TestProbeConPTYUnavailableOnNonWindows(t *testing.T) {
	err := probeConPTY()
	assertConPTYUnavailableError(t, err)
}

func TestNewPlatformTerminalSessionUnavailableOnNonWindows(t *testing.T) {
	_, err := newPlatformTerminalSession(
		openRequest{TerminalID: "stub", Cols: 80, Rows: 24},
		resolvedShell{Name: "stub"},
		terminalCallbacks{},
		func(_ string, _ func()) {},
	)
	assertConPTYUnavailableError(t, err)
}

func assertConPTYUnavailableError(t *testing.T, err error) {
	t.Helper()

	if err == nil {
		t.Fatal("expected conpty_unavailable error")
	}

	var serr *sidecarError
	if !errors.As(err, &serr) {
		t.Fatalf("expected sidecarError, got %T", err)
	}
	if serr.Code != errorCodeConPTYUnavailable {
		t.Fatalf("expected error code %q, got %q", errorCodeConPTYUnavailable, serr.Code)
	}
}
