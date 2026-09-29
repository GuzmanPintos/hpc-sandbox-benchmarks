import { defineProviderMeta } from "../provider-meta.ts";

export default defineProviderMeta("tenki", {
	displayName: "Tenki",
	vendor: "Tenki",
	website: "https://tenki.cloud",
	sdkPackage: "@tenkicloud/sandbox",
	artifact: { kind: "none" },
	inputs: ["TENKI_API_KEY"],
	isolation: {
		class: "vm",
		technology: "Full VM",
		notes:
			"Each session is a VM with its own kernel, isolated at the hypervisor layer, booting the vendor's Ubuntu 24.04 sandbox image. CPU, memory, and disk are set per session at create, so the benchmark requests exactly 4 vCPU / 8 GiB / 40 GiB.",
	},
	pricing: {
		model: "published",
		components: [
			{
				id: "cpu",
				resource: "cpu",
				billingBasis: "provisioned",
				vendorUnit: "vCPU",
				usdPerUnitHour: 0.0504,
				quantityRule: { kind: "linear", dimension: "vcpus", unitsPerTargetUnit: 1 },
			},
			{
				id: "memory",
				resource: "memory",
				billingBasis: "provisioned",
				vendorUnit: "GiB",
				usdPerUnitHour: 0.0162,
				quantityRule: { kind: "linear", dimension: "memoryGb", unitsPerTargetUnit: 1 },
			},
			{
				id: "disk",
				resource: "disk",
				billingBasis: "provisioned",
				vendorUnit: "GiB",
				usdPerUnitHour: 0.000108,
				quantityRule: { kind: "linear", dimension: "diskGb", unitsPerTargetUnit: 1 },
			},
		],
		adjustments: [
			{
				kind: "allowance",
				plan: "all",
				resource: "disk",
				quantity: 5,
				unit: "GiB",
				scope: "per_sandbox",
				notes: "The first 5 GiB of session disk is free.",
			},
		],
		targetHourlyCost: { kind: "exact", componentIds: ["cpu", "memory"] },
		notes:
			"Per-second provisioned CPU, memory, and disk pricing after included credits; disk is excluded from benchmark economics. Teardown terminates the session, so a run leaves no paused snapshot storage behind.",
		sources: [
			{ label: "Tenki pricing", url: "https://tenki.cloud/docs/pricing", checkedAt: "2026-09-29" },
		],
	},
	maturity: {
		status: "beta",
		notes:
			"Native @tenkicloud/sandbox driver covering create, readiness, command exec with shell detach, and terminate teardown; opt-in until a committed validation run exists on this tree. Like boat, it boots the vendor's stock Ubuntu 24.04 image with a runtime-installed toolchain rather than the shared Debian 13 image.",
	},
	specPinning: "settable",
	transport: {
		// Exec returns a completed envelope. A process lives only as long as its Run stream, so
		// anything past the synchronous cap goes through the harness's double-forked shell detach.
		streaming: false,
		syncCapMs: 60_000,
		detachedPoll: true,
	},
});
