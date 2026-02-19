//go:build !windows

package main

func probeConPTY() error {
	return newSidecarError(errorCodeConPTYUnavailable, "ConPTY is only available on Windows")
}

func newPlatformTerminalSession(
	req openRequest,
	shell resolvedShell,
	callbacks terminalCallbacks,
	runIsolated func(terminalID string, task func()),
) (terminalSession, error) {
	_ = req
	_ = shell
	_ = callbacks
	_ = runIsolated
	return nil, newSidecarError(errorCodeConPTYUnavailable, "ConPTY is only available on Windows")
}
