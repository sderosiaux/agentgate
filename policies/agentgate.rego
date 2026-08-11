# SPEC D3 steps 6 to 10, over the same PolicyInput the builtin TypeScript engine reads.
# Steps 1 to 5 (token, mission expiry, limits, network rules) belong to the gateway pipeline
# and are already settled before this is evaluated.
#
# Any change here has to land in packages/policy/src/engine.ts as well: the parity suite
# replays the whole decision matrix against both and compares decision, reason and policy.
package agentgate

# The action hierarchy, mirrored from packages/policy/src/actions.ts. No wildcards.
implied_actions := {"repo.read": {"issue.read", "pull_request.read"}}

resource_key := sprintf("%s:%s", [input.resource.provider, input.resource.id])

resource_in_scope if {
	resource_key in input.mission.permissions.resources
}

covers(granted, requested) if granted == requested

covers(granted, requested) if {
	requested in implied_actions[granted]
}

# True when any entry of `list` speaks for the requested action, directly or through the
# hierarchy. Used for all three lists, so denying `repo.read` also denies what it covers.
covered_by(list) if {
	some granted in list
	covers(granted, input.action.type)
}

decision := {
	"decision": "DENY",
	"reason": sprintf("resource %s is not in the mission scope", [resource_key]),
	"matchedPolicy": "mission-resource-scope",
} if {
	not resource_in_scope
} else := {
	"decision": "DENY",
	"reason": sprintf("action %s is denied by the mission", [input.action.type]),
	"matchedPolicy": "mission-denied-action",
} if {
	covered_by(input.mission.permissions.deniedActions)
} else := {
	"decision": "REQUIRE_APPROVAL",
	"reason": sprintf("action %s requires an approval", [input.action.type]),
	"matchedPolicy": "mission-approval-required",
} if {
	covered_by(input.mission.permissions.approvalActions)
} else := {
	"decision": "ALLOW",
	"reason": sprintf("action %s is allowed by the mission", [input.action.type]),
	"matchedPolicy": "mission-allowed-action",
} if {
	covered_by(input.mission.permissions.allowedActions)
} else := {
	"decision": "DENY",
	"reason": sprintf("action %s is not granted by the mission", [input.action.type]),
	"matchedPolicy": "mission-default-deny",
}
