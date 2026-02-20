package main

import (
	"errors"
	"strings"
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

func TestResolveShellResolvesGitBashFromPath(t *testing.T) {
	lookup := fakeLookup(map[string]string{
		"bash.exe": `C:\Program Files\Git\bin\bash.exe`,
	})

	resolved, err := resolveShell("gitbash", lookup)
	if err != nil {
		t.Fatalf("resolveShell failed: %v", err)
	}

	if resolved.Name != "gitbash" {
		t.Fatalf("expected gitbash shell, got %s", resolved.Name)
	}
	if resolved.Path != `C:\Program Files\Git\bin\bash.exe` {
		t.Fatalf("unexpected path: %s", resolved.Path)
	}
	if len(resolved.Args) != 2 || resolved.Args[0] != "--login" || resolved.Args[1] != "-i" {
		t.Fatalf("unexpected args: %#v", resolved.Args)
	}
}

func TestResolveShellResolvesGitBashFromGitExecutableLocation(t *testing.T) {
	lookup := fakeLookup(map[string]string{
		"git.exe": `C:\Program Files\Git\cmd\git.exe`,
	})
	expectedBashPath := `C:\Program Files\Git\bin\bash.exe`

	resolved, err := resolveShellWithOptions("gitbash", shellResolveOptions{
		LookPath: lookup,
		PathExists: fakePathExists(map[string]bool{
			expectedBashPath: true,
		}),
	})
	if err != nil {
		t.Fatalf("resolveShellWithOptions failed: %v", err)
	}

	if resolved.Path != expectedBashPath {
		t.Fatalf("unexpected path: %s", resolved.Path)
	}
}

func TestResolveShellResolvesGitBashFromOverridePath(t *testing.T) {
	overridePath := `D:\tools\Git\bin\bash.exe`

	resolved, err := resolveShellWithOptions("gitbash", shellResolveOptions{
		LookPath: fakeLookup(map[string]string{}),
		Env: map[string]string{
			gitBashEnvPath: overridePath,
		},
		PathExists: fakePathExists(map[string]bool{
			overridePath: true,
		}),
	})
	if err != nil {
		t.Fatalf("resolveShellWithOptions failed: %v", err)
	}

	if resolved.Path != overridePath {
		t.Fatalf("expected override path %s, got %s", overridePath, resolved.Path)
	}
}

func TestResolveShellReturnsShellNotFoundForMissingGitBashOverride(t *testing.T) {
	_, err := resolveShellWithOptions("gitbash", shellResolveOptions{
		LookPath: fakeLookup(map[string]string{}),
		Env: map[string]string{
			gitBashEnvPath: `D:\missing\bash.exe`,
		},
		PathExists: fakePathExists(map[string]bool{}),
	})
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
	if !strings.Contains(serr.Message, gitBashEnvPath) {
		t.Fatalf("expected missing override message, got: %s", serr.Message)
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

func fakePathExists(paths map[string]bool) pathExistsFunc {
	return func(path string) bool {
		exists, ok := paths[path]
		if !ok {
			return false
		}
		return exists
	}
}
