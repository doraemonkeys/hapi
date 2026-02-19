package main

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestDecodeRequestLineOpen(t *testing.T) {
	raw := []byte(`{"type":"open","terminalId":"t1","cwd":"C:/","shell":"pwsh","cols":80,"rows":24,"env":{"K":"V"}}`)

	decoded, err := decodeRequestLine(raw)
	if err != nil {
		t.Fatalf("decodeRequestLine failed: %v", err)
	}

	openReq, ok := decoded.(openRequest)
	if !ok {
		t.Fatalf("decoded type mismatch: %T", decoded)
	}

	if openReq.Type != requestTypeOpen {
		t.Fatalf("unexpected type: %s", openReq.Type)
	}
	if openReq.TerminalID != "t1" {
		t.Fatalf("unexpected terminal id: %s", openReq.TerminalID)
	}
	if openReq.Shell != "pwsh" {
		t.Fatalf("unexpected shell: %s", openReq.Shell)
	}
	if openReq.Env["K"] != "V" {
		t.Fatalf("unexpected env payload: %#v", openReq.Env)
	}
}

func TestDecodeRequestLineUnknownType(t *testing.T) {
	raw := []byte(`{"type":"wat"}`)
	if _, err := decodeRequestLine(raw); err == nil {
		t.Fatal("expected unknown request type error")
	}
}

func TestWriteNDJSONLineAddsTrailingNewline(t *testing.T) {
	var out bytes.Buffer

	payload := helloEvent{
		Type:     eventTypeHello,
		Version:  sidecarVersion,
		Protocol: protocolVersion,
	}
	if err := writeNDJSONLine(&out, payload); err != nil {
		t.Fatalf("writeNDJSONLine failed: %v", err)
	}

	encoded := out.Bytes()
	if len(encoded) == 0 || encoded[len(encoded)-1] != '\n' {
		t.Fatalf("payload is not NDJSON: %q", string(encoded))
	}

	var decoded helloEvent
	if err := json.Unmarshal(bytes.TrimSuffix(encoded, []byte{'\n'}), &decoded); err != nil {
		t.Fatalf("json unmarshal failed: %v", err)
	}

	if decoded.Type != eventTypeHello || decoded.Protocol != protocolVersion {
		t.Fatalf("unexpected event payload: %+v", decoded)
	}
}
