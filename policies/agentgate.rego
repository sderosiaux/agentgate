# SPEC D3 steps 6 to 10, over the same PolicyInput the builtin TypeScript engine reads.
# Steps 1 to 5 (token, mission expiry, limits, network rules) belong to the gateway pipeline
# and are already settled before this is evaluated.
#
# Any change here has to land in packages/policy/src/engine.ts as well: the parity suite
# replays the whole decision matrix against both and compares decision, reason and policy.
package agentgate

# Nothing below may leave `decision` undefined. An undefined value in a branch of the chain
# below does not stop evaluation — it lets the next branch answer, which once turned a missing
# `resource.provider` into an ALLOW on a repository that was never in scope. Belt: the helpers
# are total. Braces: this default catches anything that still slips through.
default decision := {
	"decision": "DENY",
	"reason": "policy input is not well formed",
	"matchedPolicy": "mission-default-deny",
}

# The action hierarchy, mirrored from packages/policy/src/actions.ts. No wildcards.
implied_actions := {"repo.read": {"issue.read", "pull_request.read"}}

# Total by construction: a missing or non-string field becomes "", which matches no mission
# scope and no granted action, so a malformed input can only ever be denied.
#
# These have to dereference `input` inside their own body rather than take it as an argument:
# a function called with an undefined argument is itself undefined, so the `else` would never
# get its turn and the rule would go right back to being partial.
resource_provider := input.resource.provider if {
	is_string(input.resource.provider)
} else := ""

resource_id := input.resource.id if {
	is_string(input.resource.id)
} else := ""

action_type := input.action.type if {
	is_string(input.action.type)
} else := ""

resource_key := sprintf("%s:%s", [resource_provider, resource_id])

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
	covers(granted, action_type)
}

decision := {
	"decision": "DENY",
	"reason": sprintf("resource %s is not in the mission scope", [resource_key]),
	"matchedPolicy": "mission-resource-scope",
} if {
	not resource_in_scope
} else := {
	"decision": "DENY",
	"reason": sprintf("action %s is denied by the mission", [action_type]),
	"matchedPolicy": "mission-denied-action",
} if {
	covered_by(input.mission.permissions.deniedActions)
} else := {
	"decision": "REQUIRE_APPROVAL",
	"reason": sprintf("action %s requires an approval", [action_type]),
	"matchedPolicy": "mission-approval-required",
} if {
	covered_by(input.mission.permissions.approvalActions)
} else := {
	"decision": "ALLOW",
	"reason": sprintf("action %s is allowed by the mission", [action_type]),
	"matchedPolicy": "mission-allowed-action",
} if {
	covered_by(input.mission.permissions.allowedActions)
} else := {
	"decision": "DENY",
	"reason": sprintf("action %s is not granted by the mission", [action_type]),
	"matchedPolicy": "mission-default-deny",
}
