//go:build windows

package main

import (
	"syscall"
	"testing"
)

func TestProbeConPTYUsesCreatePseudoConsolePath(t *testing.T) {
	if err := probeConPTY(); err != nil {
		t.Fatalf("expected ConPTY probe to succeed, got %v", err)
	}
}

func TestResizePseudoConsole(t *testing.T) {
	if err := ensureConPTYAPIs(); err != nil {
		t.Fatalf("ConPTY APIs should be available on supported Windows builds: %v", err)
	}

	ptyInputRead, ptyInputWrite, err := createPipePair()
	if err != nil {
		t.Fatalf("failed to create ConPTY input pipe: %v", err)
	}
	defer closeHandleIfValid(&ptyInputRead)
	defer closeHandleIfValid(&ptyInputWrite)

	ptyOutputRead, ptyOutputWrite, err := createPipePair()
	if err != nil {
		t.Fatalf("failed to create ConPTY output pipe: %v", err)
	}
	defer closeHandleIfValid(&ptyOutputRead)
	defer closeHandleIfValid(&ptyOutputWrite)

	pseudoConsole, err := createPseudoConsole(80, 24, ptyInputRead, ptyOutputWrite)
	if err != nil {
		t.Fatalf("failed to create pseudo console: %v", err)
	}
	defer closePseudoConsole(pseudoConsole)

	if err := resizePseudoConsole(pseudoConsole, 120, 40); err != nil {
		t.Fatalf("expected resize to succeed, got %v", err)
	}
}

func TestNewConPTYStartupInfoDisablesInheritedStdHandles(t *testing.T) {
	const attributeList = uintptr(0x1234)

	startupInfo := newConPTYStartupInfo(attributeList)

	if startupInfo.AttributeList != attributeList {
		t.Fatalf("expected attribute list %x, got %x", attributeList, startupInfo.AttributeList)
	}
	if startupInfo.StartupInfo.Cb == 0 {
		t.Fatal("expected startup info cb to be initialized")
	}
	if startupInfo.StartupInfo.Flags&syscall.STARTF_USESTDHANDLES == 0 {
		t.Fatal("expected STARTF_USESTDHANDLES to be set")
	}
	if startupInfo.StartupInfo.StdInput != syscall.InvalidHandle {
		t.Fatalf("expected StdInput to be InvalidHandle, got %v", startupInfo.StartupInfo.StdInput)
	}
	if startupInfo.StartupInfo.StdOutput != syscall.InvalidHandle {
		t.Fatalf("expected StdOutput to be InvalidHandle, got %v", startupInfo.StartupInfo.StdOutput)
	}
	if startupInfo.StartupInfo.StdErr != syscall.InvalidHandle {
		t.Fatalf("expected StdErr to be InvalidHandle, got %v", startupInfo.StartupInfo.StdErr)
	}
}
