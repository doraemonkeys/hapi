package main

import (
	"errors"
	"os/exec"
)

type shellLookupFunc func(file string) (string, error)

type resolvedShell struct {
	Name string
	Path string
	Args []string
}

type shellSpec struct {
	Executable string
	Args       []string
}

var shellOrder = []string{"pwsh", "powershell", "cmd"}

var shellSpecs = map[string]shellSpec{
	"pwsh": {
		Executable: "pwsh.exe",
		Args:       []string{"-NoLogo"},
	},
	"powershell": {
		Executable: "powershell.exe",
		Args:       []string{"-NoLogo"},
	},
	"cmd": {
		Executable: "cmd.exe",
		Args:       []string{"/Q"},
	},
}

func resolveShell(requested string, lookPath shellLookupFunc) (resolvedShell, error) {
	if lookPath == nil {
		lookPath = exec.LookPath
	}

	if requested == "" {
		return resolveDefaultShell(lookPath)
	}

	spec, ok := shellSpecs[requested]
	if !ok {
		return resolvedShell{}, newSidecarError(errorCodeShellNotFound, "unsupported shell %q", requested)
	}

	path, err := lookPath(spec.Executable)
	if err != nil {
		return resolvedShell{}, newSidecarError(errorCodeShellNotFound, "%s not found in PATH", spec.Executable)
	}

	return resolvedShell{
		Name: requested,
		Path: path,
		Args: append([]string(nil), spec.Args...),
	}, nil
}

func resolveDefaultShell(lookPath shellLookupFunc) (resolvedShell, error) {
	var lastErr error
	for _, name := range shellOrder {
		spec := shellSpecs[name]
		path, err := lookPath(spec.Executable)
		if err == nil {
			return resolvedShell{
				Name: name,
				Path: path,
				Args: append([]string(nil), spec.Args...),
			}, nil
		}
		lastErr = err
	}

	if lastErr == nil {
		lastErr = errors.New("no shell candidates")
	}

	return resolvedShell{}, newSidecarError(
		errorCodeShellNotFound,
		"no supported shell found (tried %s): %v",
		fmtShellCandidates(),
		lastErr,
	)
}

func fmtShellCandidates() string {
	return "pwsh.exe, powershell.exe, cmd.exe"
}

func sidecarErrorFrom(err error, fallbackCode string) *sidecarError {
	var serr *sidecarError
	if errors.As(err, &serr) {
		return serr
	}

	return &sidecarError{
		Code:    fallbackCode,
		Message: err.Error(),
	}
}
