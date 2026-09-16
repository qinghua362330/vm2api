package telemetry

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestInitEventUsesOfficial1PEnvelope(t *testing.T) {
	ev := InitEvent(Identity{
		DeviceID:           "dev-hash",
		AccountUUID:        "acc",
		OrgUUID:            "org",
		Email:              "slot@example.com",
		SessionID:          "sess",
		Platform:           "linux",
		PlatformRaw:        "linux",
		Arch:               "x64",
		NodeVersion:        "v24.3.0",
		Locale:             "en_US.UTF-8",
		Timezone:           "America/Los_Angeles",
		CLIVersion:         "2.1.233",
		Entrypoint:         "cli",
		LinuxDistroID:      "ubuntu",
		LinuxDistroVersion: "24.04",
		LinuxKernel:        "6.8.0-generic",
	}, time.Date(2026, 8, 23, 1, 0, 0, 0, time.UTC))

	if ev.EventType != eventTypeInternal {
		t.Fatalf("event_type=%q", ev.EventType)
	}
	if ev.EventData["event_name"] != eventTenguInit {
		t.Fatalf("event_name=%v", ev.EventData["event_name"])
	}
	raw, err := json.Marshal(BatchRequest{Events: []Event{ev}})
	if err != nil {
		t.Fatal(err)
	}
	if ContainsForbidden(raw) {
		t.Fatalf("forbidden field leaked: %s", raw)
	}
	for _, must := range []string{
		`"event_type":"ClaudeCodeInternalEvent"`,
		`"event_name":"tengu_init"`,
		`"device_id":"dev-hash"`,
		`"account_uuid":"acc"`,
		`"organization_uuid":"org"`,
		`"email":"slot@example.com"`,
		`"session_id":"sess"`,
		`"client_timestamp":"2026-08-23T01:00:00.000Z"`,
		`"platform":"linux"`,
		`"platform_raw":"linux"`,
		`"arch":"x64"`,
		`"node_version":"v24.3.0"`,
		`"linux_distro_id":"ubuntu"`,
		`"linux_distro_version":"24.04"`,
		`"linux_kernel":"6.8.0-generic"`,
		`"entrypoint":"cli"`,
		`"user_type":"external"`,
		`"client_type":"cli"`,
	} {
		if !strings.Contains(string(raw), must) {
			t.Fatalf("missing %s in %s", must, raw)
		}
	}
	if strings.Contains(string(raw), `"properties"`) {
		t.Fatalf("legacy properties envelope leaked: %s", raw)
	}
	for _, drop := range []string{"hostname", "kernel_release", "os_pretty", "\"os_id\"", "runtime_kind"} {
		if strings.Contains(string(raw), drop) {
			t.Fatalf("did not expect %q in %s", drop, raw)
		}
	}
}

func TestSuccessEventMatchesBridgeEnvelope(t *testing.T) {
	ev := SuccessEvent(Identity{
		DeviceID:    "dev-hash",
		AccountUUID: "acc",
		CLIVersion:  "2.1.241",
		Platform:    "linux",
	}, time.Date(2026, 8, 23, 1, 0, 0, 0, time.UTC), 12, "claude-sonnet-5")
	if ev.EventData["event_name"] != eventTenguSuccess {
		t.Fatalf("event_name=%v", ev.EventData["event_name"])
	}
	if ev.EventData["process"] == nil {
		t.Fatal("process missing")
	}
	raw, _ := json.Marshal(ev)
	if ContainsForbidden(raw) {
		t.Fatalf("forbidden: %s", raw)
	}
	if !strings.Contains(string(raw), `"linux_kernel"`) {
		t.Fatalf("full env missing linux_kernel: %s", raw)
	}
}

func TestGrowthbookPrefersOfficialUserID(t *testing.T) {
	body := GrowthbookEval(Identity{
		DeviceID:         "machine",
		UserID:           "userid",
		AccountUUID:      "acc",
		SubscriptionType: "apple_subscription",
		CLIVersion:       "2.1.241",
	})
	attrs := body["attributes"].(map[string]any)
	if attrs["id"] != "userid" || attrs["deviceID"] != "userid" {
		t.Fatalf("attrs=%v", attrs)
	}
	if attrs["subscriptionType"] != "apple_subscription" {
		t.Fatalf("subscription=%v", attrs["subscriptionType"])
	}
}

func TestInitEventOmitsEmptyOptionalFields(t *testing.T) {
	ev := InitEvent(Identity{Platform: "linux"}, time.Unix(0, 0).UTC())
	if _, ok := ev.EventData["email"]; ok {
		t.Fatal("empty email must be omitted")
	}
	if _, ok := ev.EventData["auth"]; ok {
		t.Fatal("empty auth must be omitted")
	}
	env, _ := ev.EventData["env"].(map[string]any)
	if env["is_ci"] != false {
		t.Fatalf("is_ci=%v", env["is_ci"])
	}
}

// deployment_environment used to be derived twice with different rules: the Node
// path returned "" for non-Linux while this package always produced
// "unknown-<platform>", so every darwin/win32 persona shipped a value the two
// implementations disagreed on. The rule is now shared:
//
//	explicit || "unknown-" + platform
//
// mirrored in src/lib/identity/telemetry-env.mjs deploymentEnvironmentFor().
// Keep these cases in lockstep with test/unit/telemetry-parity.test.mjs.
func TestDeploymentEnvironmentMatchesNodeRule(t *testing.T) {
	cases := []struct {
		name     string
		platform string
		explicit string
		want     string
	}{
		{name: "linux", platform: "linux", want: "unknown-linux"},
		{name: "darwin", platform: "darwin", want: "unknown-darwin"},
		{name: "win32", platform: "win32", want: "unknown-win32"},
		{name: "empty platform defaults to linux", platform: "", want: "unknown-linux"},
		{name: "explicit wins", platform: "linux", explicit: "prod", want: "prod"},
		{name: "explicit wins on darwin", platform: "darwin", explicit: "unknown-linux", want: "unknown-linux"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ev := InitEvent(
				Identity{Platform: tc.platform, DeploymentEnvironment: tc.explicit},
				time.Unix(0, 0).UTC(),
			)
			env, _ := ev.EventData["env"].(map[string]any)
			if got := env["deployment_environment"]; got != tc.want {
				t.Fatalf("deployment_environment=%v want %q", got, tc.want)
			}
		})
	}
}
