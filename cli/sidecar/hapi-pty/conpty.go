//go:build windows

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

const (
	minTerminalDimension             = 1
	maxTerminalDimension             = 32767
	defaultProbeCols                 = 80
	defaultProbeRows                 = 25
	procThreadAttributePseudoConsole = 0x00020016
	extendedStartupInfoPresent       = 0x00080000
	terminateExitCode                = 1
	errorInvalidHandle               = 6
)

var (
	kernel32Proc = syscall.NewLazyDLL("kernel32.dll")

	procCreatePseudoConsole               = kernel32Proc.NewProc("CreatePseudoConsole")
	procResizePseudoConsole               = kernel32Proc.NewProc("ResizePseudoConsole")
	procClosePseudoConsole                = kernel32Proc.NewProc("ClosePseudoConsole")
	procInitializeProcThreadAttributeList = kernel32Proc.NewProc("InitializeProcThreadAttributeList")
	procUpdateProcThreadAttribute         = kernel32Proc.NewProc("UpdateProcThreadAttribute")
	procDeleteProcThreadAttributeList     = kernel32Proc.NewProc("DeleteProcThreadAttributeList")
)

type conptyHandle uintptr

type windowsCoord struct {
	X int16
	Y int16
}

type startupInfoEx struct {
	StartupInfo   syscall.StartupInfo
	AttributeList uintptr
}

type conptySession struct {
	conpty    conptyHandle
	stdin     io.WriteCloser
	output    io.ReadCloser
	process   syscall.Handle
	closeOnce sync.Once
}

func probeConPTY() error {
	if err := ensureConPTYAPIs(); err != nil {
		return err
	}

	ptyInputRead, ptyInputWrite, err := createPipePair()
	if err != nil {
		return newSidecarError(errorCodeConPTYUnavailable, "ConPTY probe failed to create input pipe: %v", err)
	}
	defer closeHandleIfValid(&ptyInputRead)
	defer closeHandleIfValid(&ptyInputWrite)

	ptyOutputRead, ptyOutputWrite, err := createPipePair()
	if err != nil {
		return newSidecarError(errorCodeConPTYUnavailable, "ConPTY probe failed to create output pipe: %v", err)
	}
	defer closeHandleIfValid(&ptyOutputRead)
	defer closeHandleIfValid(&ptyOutputWrite)

	pseudoConsole, err := createPseudoConsole(defaultProbeCols, defaultProbeRows, ptyInputRead, ptyOutputWrite)
	if err != nil {
		return newSidecarError(errorCodeConPTYUnavailable, "CreatePseudoConsole probe failed: %v", err)
	}
	defer closePseudoConsole(pseudoConsole)

	return nil
}

func newPlatformTerminalSession(
	req openRequest,
	shell resolvedShell,
	callbacks terminalCallbacks,
	runIsolated func(terminalID string, task func()),
) (terminalSession, error) {
	if err := ensureConPTYAPIs(); err != nil {
		return nil, err
	}

	ptyInputRead, ptyInputWrite, err := createPipePair()
	if err != nil {
		return nil, newSidecarError(errorCodeStartupFailed, "failed to create ConPTY input pipe: %v", err)
	}
	defer closeHandleIfValid(&ptyInputRead)
	defer closeHandleIfValid(&ptyInputWrite)

	ptyOutputRead, ptyOutputWrite, err := createPipePair()
	if err != nil {
		return nil, newSidecarError(errorCodeStartupFailed, "failed to create ConPTY output pipe: %v", err)
	}
	defer closeHandleIfValid(&ptyOutputRead)
	defer closeHandleIfValid(&ptyOutputWrite)

	pseudoConsole, err := createPseudoConsole(req.Cols, req.Rows, ptyInputRead, ptyOutputWrite)
	if err != nil {
		return nil, newSidecarError(errorCodeStartupFailed, "failed to create pseudo console: %v", err)
	}
	pseudoConsoleOpened := true
	defer func() {
		if pseudoConsoleOpened {
			closePseudoConsole(pseudoConsole)
		}
	}()

	closeHandleIfValid(&ptyInputRead)
	closeHandleIfValid(&ptyOutputWrite)

	stdinFile := os.NewFile(uintptr(ptyInputWrite), "conpty-stdin")
	if stdinFile == nil {
		return nil, newSidecarError(errorCodeStartupFailed, "failed to attach ConPTY stdin handle")
	}
	ptyInputWrite = 0

	outputFile := os.NewFile(uintptr(ptyOutputRead), "conpty-output")
	if outputFile == nil {
		_ = stdinFile.Close()
		return nil, newSidecarError(errorCodeStartupFailed, "failed to attach ConPTY output handle")
	}
	ptyOutputRead = 0

	processHandle, err := startConPTYProcess(req, shell, pseudoConsole)
	if err != nil {
		_ = stdinFile.Close()
		_ = outputFile.Close()
		return nil, err
	}

	session := &conptySession{
		conpty:  pseudoConsole,
		stdin:   stdinFile,
		output:  outputFile,
		process: processHandle,
	}
	pseudoConsoleOpened = false

	runIsolated(req.TerminalID, func() {
		streamOutput(session.output, callbacks.Output)
	})
	runIsolated(req.TerminalID, func() {
		callbacks.Exit(waitForProcessExit(session.process))
		closeHandle(session.process)
	})

	return session, nil
}

func (s *conptySession) Write(data string) error {
	if s.stdin == nil {
		return newSidecarError(errorCodeStartupFailed, "stdin pipe is closed")
	}

	_, err := io.WriteString(s.stdin, data)
	if err != nil {
		return newSidecarError(errorCodeStartupFailed, "stdin write failed: %v", err)
	}

	return nil
}

func (s *conptySession) Resize(cols int, rows int) error {
	if s.conpty == 0 {
		return newSidecarError(errorCodeStartupFailed, "pseudo console is closed")
	}

	if err := resizePseudoConsole(s.conpty, cols, rows); err != nil {
		return newSidecarError(errorCodeStartupFailed, "ConPTY resize failed: %v", err)
	}

	return nil
}

func (s *conptySession) Close() error {
	var closeErr error
	s.closeOnce.Do(func() {
		if s.stdin != nil {
			_ = s.stdin.Close()
			s.stdin = nil
		}

		if s.output != nil {
			_ = s.output.Close()
			s.output = nil
		}

		if s.conpty != 0 {
			closePseudoConsole(s.conpty)
			s.conpty = 0
		}

		if s.process != 0 {
			err := syscall.TerminateProcess(s.process, terminateExitCode)
			if err != nil && !errors.Is(err, os.ErrProcessDone) && !isAlreadyClosedProcessError(err) {
				closeErr = err
			}
		}
	})

	return closeErr
}

func ensureConPTYAPIs() error {
	conptyProcs := []*syscall.LazyProc{
		procCreatePseudoConsole,
		procResizePseudoConsole,
		procClosePseudoConsole,
		procInitializeProcThreadAttributeList,
		procUpdateProcThreadAttribute,
		procDeleteProcThreadAttributeList,
	}

	for _, proc := range conptyProcs {
		if err := proc.Find(); err != nil {
			return newSidecarError(errorCodeConPTYUnavailable, "%s is unavailable: %v", proc.Name, err)
		}
	}

	return nil
}

func createPipePair() (syscall.Handle, syscall.Handle, error) {
	var readHandle syscall.Handle
	var writeHandle syscall.Handle
	if err := syscall.CreatePipe(&readHandle, &writeHandle, nil, 0); err != nil {
		return 0, 0, err
	}

	return readHandle, writeHandle, nil
}

func createPseudoConsole(cols int, rows int, inputRead syscall.Handle, outputWrite syscall.Handle) (conptyHandle, error) {
	coord := makeCoord(cols, rows)
	coordValue := packCoord(coord)

	var pseudoConsole conptyHandle
	hr, _, _ := procCreatePseudoConsole.Call(
		uintptr(coordValue),
		uintptr(inputRead),
		uintptr(outputWrite),
		0,
		uintptr(unsafe.Pointer(&pseudoConsole)),
	)
	if hr != 0 {
		return 0, fmt.Errorf("HRESULT 0x%08X", uint32(hr))
	}

	return pseudoConsole, nil
}

func resizePseudoConsole(handle conptyHandle, cols int, rows int) error {
	coord := makeCoord(cols, rows)
	coordValue := packCoord(coord)

	hr, _, _ := procResizePseudoConsole.Call(uintptr(handle), uintptr(coordValue))
	if hr != 0 {
		return fmt.Errorf("HRESULT 0x%08X", uint32(hr))
	}

	return nil
}

func closePseudoConsole(handle conptyHandle) {
	if handle == 0 {
		return
	}

	procClosePseudoConsole.Call(uintptr(handle))
}

func makeCoord(cols int, rows int) windowsCoord {
	if cols < minTerminalDimension {
		cols = minTerminalDimension
	} else if cols > maxTerminalDimension {
		cols = maxTerminalDimension
	}
	if rows < minTerminalDimension {
		rows = minTerminalDimension
	} else if rows > maxTerminalDimension {
		rows = maxTerminalDimension
	}
	return windowsCoord{
		X: int16(cols),
		Y: int16(rows),
	}
}

func packCoord(coord windowsCoord) uint32 {
	return uint32(uint16(coord.X)) | (uint32(uint16(coord.Y)) << 16)
}

func startConPTYProcess(req openRequest, shell resolvedShell, pseudoConsole conptyHandle) (syscall.Handle, error) {
	commandLine := buildCommandLine(shell.Path, shell.Args)
	commandLineUTF16, err := syscall.UTF16FromString(commandLine)
	if err != nil {
		return 0, newSidecarError(errorCodeStartupFailed, "failed to encode command line: %v", err)
	}

	appNameUTF16, err := syscall.UTF16PtrFromString(shell.Path)
	if err != nil {
		return 0, newSidecarError(errorCodeStartupFailed, "failed to encode shell path: %v", err)
	}

	var cwdUTF16 *uint16
	if req.Cwd != "" {
		cwdUTF16, err = syscall.UTF16PtrFromString(req.Cwd)
		if err != nil {
			return 0, newSidecarError(errorCodeStartupFailed, "failed to encode cwd: %v", err)
		}
	}

	environmentBlock, err := buildEnvironmentBlock(mergeEnvironment(os.Environ(), req.Env))
	if err != nil {
		return 0, newSidecarError(errorCodeStartupFailed, "failed to encode environment block: %v", err)
	}

	attributeList, attributeListBacking, err := newPseudoConsoleAttributeList(pseudoConsole)
	if err != nil {
		return 0, newSidecarError(errorCodeStartupFailed, "failed to build process attribute list: %v", err)
	}
	defer deleteProcThreadAttributeList(attributeList)

	startupInfo := newConPTYStartupInfo(attributeList)

	processInfo := syscall.ProcessInformation{}
	createFlags := uint32(extendedStartupInfoPresent | syscall.CREATE_UNICODE_ENVIRONMENT)

	var environmentPtr *uint16
	if len(environmentBlock) > 0 {
		environmentPtr = &environmentBlock[0]
	}

	err = syscall.CreateProcess(
		appNameUTF16,
		&commandLineUTF16[0],
		nil,
		nil,
		false,
		createFlags,
		environmentPtr,
		cwdUTF16,
		&startupInfo.StartupInfo,
		&processInfo,
	)
	if err != nil {
		return 0, newSidecarError(errorCodeStartupFailed, "failed to start shell process: %v", err)
	}

	closeHandleIfValid(&processInfo.Thread)
	runtime.KeepAlive(attributeListBacking)

	return processInfo.Process, nil
}

func newPseudoConsoleAttributeList(pseudoConsole conptyHandle) (uintptr, []byte, error) {
	var size uintptr
	_, _, firstErr := procInitializeProcThreadAttributeList.Call(
		0,
		1,
		0,
		uintptr(unsafe.Pointer(&size)),
	)
	if size == 0 {
		return 0, nil, firstErr
	}

	backing := make([]byte, size)
	attributeList := uintptr(unsafe.Pointer(&backing[0]))
	ret, _, err := procInitializeProcThreadAttributeList.Call(
		attributeList,
		1,
		0,
		uintptr(unsafe.Pointer(&size)),
	)
	if ret == 0 {
		return 0, nil, err
	}

	ret, _, err = procUpdateProcThreadAttribute.Call(
		attributeList,
		0,
		procThreadAttributePseudoConsole,
		uintptr(pseudoConsole),
		unsafe.Sizeof(pseudoConsole),
		0,
		0,
	)
	if ret == 0 {
		deleteProcThreadAttributeList(attributeList)
		return 0, nil, err
	}

	return attributeList, backing, nil
}

func newConPTYStartupInfo(attributeList uintptr) startupInfoEx {
	startupInfo := startupInfoEx{}
	startupInfo.StartupInfo.Cb = uint32(unsafe.Sizeof(startupInfo))
	// Prevent child shell from inheriting sidecar stdio pipes.
	// Without explicit std handles, some shells can read/write sidecar protocol stream.
	startupInfo.StartupInfo.Flags |= syscall.STARTF_USESTDHANDLES
	startupInfo.StartupInfo.StdInput = syscall.InvalidHandle
	startupInfo.StartupInfo.StdOutput = syscall.InvalidHandle
	startupInfo.StartupInfo.StdErr = syscall.InvalidHandle
	startupInfo.AttributeList = attributeList
	return startupInfo
}

func deleteProcThreadAttributeList(attributeList uintptr) {
	if attributeList == 0 {
		return
	}
	procDeleteProcThreadAttributeList.Call(attributeList)
}

func closeHandleIfValid(handle *syscall.Handle) {
	if handle == nil || *handle == 0 {
		return
	}
	closeHandle(*handle)
	*handle = 0
}

func closeHandle(handle syscall.Handle) {
	if handle == 0 {
		return
	}
	_ = syscall.CloseHandle(handle)
}

func waitForProcessExit(process syscall.Handle) int {
	if process == 0 {
		return -1
	}

	event, err := syscall.WaitForSingleObject(process, syscall.INFINITE)
	if err != nil || event != syscall.WAIT_OBJECT_0 {
		return -1
	}

	var exitCode uint32
	if err := syscall.GetExitCodeProcess(process, &exitCode); err != nil {
		return -1
	}

	return int(exitCode)
}

func isAlreadyClosedProcessError(err error) bool {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return false
	}
	return errno == syscall.ERROR_ACCESS_DENIED || errno == syscall.Errno(errorInvalidHandle)
}

func buildCommandLine(path string, args []string) string {
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, syscall.EscapeArg(path))
	for _, arg := range args {
		parts = append(parts, syscall.EscapeArg(arg))
	}
	return strings.Join(parts, " ")
}

func buildEnvironmentBlock(env []string) ([]uint16, error) {
	if len(env) == 0 {
		return []uint16{0}, nil
	}

	block := make([]uint16, 0, len(env)*16)
	for _, item := range env {
		encoded, err := syscall.UTF16FromString(item)
		if err != nil {
			return nil, err
		}
		block = append(block, encoded...)
	}
	block = append(block, 0)
	return block, nil
}
