package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type shellLookupFunc func(file string) (string, error)
type pathExistsFunc func(path string) bool

type resolvedShell struct {
	Name string
	Path string
	Args []string
}

type shellSpec struct {
	Executable string
	Args       []string
}

type shellResolveOptions struct {
	LookPath   shellLookupFunc
	PathExists pathExistsFunc
	Env        map[string]string
}

const (
	gitBashEnvPath = "HAPI_GIT_BASH_PATH"
)

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
	"gitbash": {
		Executable: "bash.exe",
		Args:       []string{"--login", "-i"},
	},
}

func resolveShell(requested string, lookPath shellLookupFunc) (resolvedShell, error) {
	return resolveShellWithOptions(requested, shellResolveOptions{
		LookPath: lookPath,
	})
}

func resolveShellWithOptions(requested string, options shellResolveOptions) (resolvedShell, error) {
	lookPath := options.LookPath
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

	path, err := resolveShellPath(requested, spec, options, lookPath)
	if err != nil {
		return resolvedShell{}, err
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

func resolveShellPath(
	requested string,
	spec shellSpec,
	options shellResolveOptions,
	lookPath shellLookupFunc,
) (string, error) {
	if requested == "gitbash" {
		return resolveGitBashPath(options, lookPath)
	}

	path, err := lookPath(spec.Executable)
	if err != nil {
		return "", newSidecarError(errorCodeShellNotFound, "%s not found in PATH", spec.Executable)
	}
	return path, nil
}

func resolveGitBashPath(options shellResolveOptions, lookPath shellLookupFunc) (string, error) {
	pathExists := options.PathExists
	if pathExists == nil {
		pathExists = defaultPathExists
	}

	overridePath, hasOverride := lookupEnv(options.Env, gitBashEnvPath)
	if hasOverride {
		trimmed := strings.TrimSpace(overridePath)
		if trimmed != "" {
			candidate := filepath.Clean(trimmed)
			if pathExists(candidate) {
				return candidate, nil
			}
			return "", newSidecarError(errorCodeShellNotFound, "%s points to missing file: %s", gitBashEnvPath, candidate)
		}
	}

	if resolvedPath, err := lookPath("bash.exe"); err == nil {
		return resolvedPath, nil
	}

	attemptedCandidates := []string{"bash.exe (PATH)"}

	if gitPath, err := lookPath("git.exe"); err == nil {
		gitDerivedCandidates := gitBashCandidatesFromGitPath(gitPath)
		for _, candidate := range gitDerivedCandidates {
			attemptedCandidates = append(attemptedCandidates, candidate)
			if pathExists(candidate) {
				return candidate, nil
			}
		}
	} else {
		attemptedCandidates = append(attemptedCandidates, "git.exe (PATH)")
	}

	for _, candidate := range gitBashCommonCandidates(options.Env) {
		attemptedCandidates = append(attemptedCandidates, candidate)
		if pathExists(candidate) {
			return candidate, nil
		}
	}

	return "", newSidecarError(
		errorCodeShellNotFound,
		"git bash not found (tried %s)",
		strings.Join(uniqueNonEmpty(attemptedCandidates), ", "),
	)
}

func gitBashCandidatesFromGitPath(gitPath string) []string {
	gitDir := filepath.Dir(filepath.Clean(gitPath))
	return uniqueNonEmpty([]string{
		filepath.Clean(filepath.Join(gitDir, "..", "bin", "bash.exe")),
		filepath.Clean(filepath.Join(gitDir, "..", "usr", "bin", "bash.exe")),
	})
}

func gitBashCommonCandidates(env map[string]string) []string {
	candidates := []string{
		`C:\Program Files\Git\bin\bash.exe`,
		`C:\Program Files (x86)\Git\bin\bash.exe`,
	}

	programFilesEnvNames := []string{"ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"}
	for _, envName := range programFilesEnvNames {
		if programFiles, ok := lookupEnv(env, envName); ok {
			candidates = append(candidates, filepath.Join(programFiles, "Git", "bin", "bash.exe"))
		}
	}

	if localAppData, ok := lookupEnv(env, "LocalAppData"); ok {
		candidates = append(candidates, filepath.Join(localAppData, "Programs", "Git", "bin", "bash.exe"))
	}

	if scoopRoot, ok := lookupEnv(env, "SCOOP"); ok {
		candidates = append(candidates, filepath.Join(scoopRoot, "apps", "git", "current", "bin", "bash.exe"))
	}

	if userProfile, ok := lookupEnv(env, "USERPROFILE"); ok {
		candidates = append(candidates, filepath.Join(userProfile, "scoop", "apps", "git", "current", "bin", "bash.exe"))
	}

	return uniqueNonEmpty(candidates)
}

func defaultPathExists(path string) bool {
	if path == "" {
		return false
	}

	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return !info.IsDir()
}

func lookupEnv(env map[string]string, key string) (string, bool) {
	if env != nil {
		value, ok := env[key]
		return value, ok
	}
	return os.LookupEnv(key)
}

func uniqueNonEmpty(items []string) []string {
	seen := map[string]struct{}{}
	unique := make([]string, 0, len(items))
	for _, item := range items {
		trimmed := strings.TrimSpace(item)
		if trimmed == "" {
			continue
		}
		if _, exists := seen[trimmed]; exists {
			continue
		}
		seen[trimmed] = struct{}{}
		unique = append(unique, trimmed)
	}
	return unique
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
