package main

import (
	"errors"
	"testing"
)

func TestResolveShellPrefersPwshByDefault(t *testing.T) {
	lookup := fakeLookup(map[string]string{
		"pwsh.exe":       `C:\Program Files\PowerShell\7\pwsh.exe`,
		"powershell.exe": `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
		"cmd.exe":        `C:\Windows\System32\cmd.exe`,
	})

	resolved, err := resolveShell("", lookup)
	if err != nil {
		t.Fatalf("resolveShell failed: %v", err)
	}

	if resolved.Name != "pwsh" {
		t.Fatalf("expected pwsh fallback, got %s", resolved.Name)
	}
	if resolved.Path != `C:\Program Files\PowerShell\7\pwsh.exe` {
		t.Fatalf("unexpected path: %s", resolved.Path)
	}
	if len(resolved.Args) != 1 || resolved.Args[0] != "-NoLogo" {
		t.Fatalf("unexpected args: %#v", resolved.Args)
	}
}

func TestResolveShellFallsBackToCmd(t *testing.T) {
	lookup := fakeLookup(map[string]string{
		"cmd.exe": `C:\Windows\System32\cmd.exe`,
	})

	resolved, err := resolveShell("", lookup)
	if err != nil {
		t.Fatalf("resolveShell failed: %v", err)
	}

	if resolved.Name != "cmd" {
		t.Fatalf("expected cmd fallback, got %s", resolved.Name)
	}
}

func TestResolveShellReturnsShellNotFoundForUnavailableRequestedShell(t *testing.T) {
	lookup := fakeLookup(map[string]string{})

	_, err := resolveShell("pwsh", lookup)
	if err == nil {
		t.Fatal("expected shell_not_found error")
	}

	var serr *sidecarError
	if !errors.As(err, &serr) {
		t.Fatalf("expected sidecarError, got %T", err)
	}
	if serr.Code != errorCodeShellNotFound {
		t.Fatalf("unexpected error code: %s", serr.Code)
	}
}

func fakeLookup(paths map[string]string) shellLookupFunc {
	return func(file string) (string, error) {
		path, ok := paths[file]
		if !ok {
			return "", errors.New("not found")
		}
		return path, nil
	}
}
