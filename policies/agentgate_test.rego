package agentgate_test

import data.agentgate

scope := ["github:acme/payments"]

# A full PolicyInput with only the fields the policy reads varying.
input_with(permissions, resource, action) := {
	"identity": {"principalId": "usr_1", "agentId": "agt_1", "agentType": "claude-code"},
	"mission": {
		"id": "msn_1",
		"intent": "triage the payments backlog",
		"permissions": permissions,
		"network": {"allow": [{"host": "api.github.com"}], "deny": []},
		"expiresAt": "2099-01-01T00:00:00.000Z",
	},
	"resource": resource,
	"action": action,
	"network": {"host": "api.github.com", "path": "/repos/acme/payments"},
	"environment": {"name": "test"},
	"currentState": {"requestCount": 0, "bytesTotal": 0},
	"data": {},
}

permissions_with(allowed, approval, denied) := {
	"resources": scope,
	"allowedActions": allowed,
	"approvalActions": approval,
	"deniedActions": denied,
}

payments := {"provider": "github", "id": "acme/payments"}

reads := {"type": "repo.read", "method": "GET"}

deletes := {"type": "repository.delete", "method": "DELETE"}

test_allowed_action_is_allowed if {
	result := agentgate.decision with input as input_with(permissions_with(["repo.read"], [], []), payments, reads)
	result == {
		"decision": "ALLOW",
		"reason": "action repo.read is allowed by the mission",
		"matchedPolicy": "mission-allowed-action",
	}
}

test_hierarchy_grants_issue_read if {
	result := agentgate.decision with input as input_with(
		permissions_with(["repo.read"], [], []),
		payments,
		{"type": "issue.read", "method": "GET"},
	)
	result.decision == "ALLOW"
}

test_hierarchy_is_one_way if {
	result := agentgate.decision with input as input_with(
		permissions_with(["issue.read"], [], []),
		payments,
		reads,
	)
	result.matchedPolicy == "mission-default-deny"
}

test_unlisted_action_is_denied_by_default if {
	result := agentgate.decision with input as input_with(permissions_with(["repo.read"], [], []), payments, deletes)
	result == {
		"decision": "DENY",
		"reason": "action repository.delete is not granted by the mission",
		"matchedPolicy": "mission-default-deny",
	}
}

test_denied_beats_allowed if {
	result := agentgate.decision with input as input_with(
		permissions_with(["repository.delete"], [], ["repository.delete"]),
		payments,
		deletes,
	)
	result.matchedPolicy == "mission-denied-action"
}

test_denied_beats_approval if {
	result := agentgate.decision with input as input_with(
		permissions_with([], ["repository.delete"], ["repository.delete"]),
		payments,
		deletes,
	)
	result.matchedPolicy == "mission-denied-action"
}

test_denying_repo_read_denies_the_reads_it_covers if {
	result := agentgate.decision with input as input_with(
		permissions_with(["repo.read"], [], ["repo.read"]),
		payments,
		{"type": "issue.read", "method": "GET"},
	)
	result.matchedPolicy == "mission-denied-action"
}

test_approval_beats_allowed if {
	result := agentgate.decision with input as input_with(
		permissions_with(["repo.read", "pull_request.create"], ["pull_request.create"], []),
		payments,
		{"type": "pull_request.create", "method": "POST"},
	)
	result == {
		"decision": "REQUIRE_APPROVAL",
		"reason": "action pull_request.create requires an approval",
		"matchedPolicy": "mission-approval-required",
	}
}

test_out_of_scope_resource_is_denied if {
	result := agentgate.decision with input as input_with(
		permissions_with(["repo.read"], [], []),
		{"provider": "github", "id": "acme/secrets"},
		reads,
	)
	result == {
		"decision": "DENY",
		"reason": "resource github:acme/secrets is not in the mission scope",
		"matchedPolicy": "mission-resource-scope",
	}
}

test_scope_is_checked_before_the_denied_list if {
	result := agentgate.decision with input as input_with(
		permissions_with([], [], ["repository.delete"]),
		{"provider": "github", "id": "acme/secrets"},
		deletes,
	)
	result.matchedPolicy == "mission-resource-scope"
}

test_provider_is_part_of_the_scope_key if {
	result := agentgate.decision with input as input_with(
		permissions_with(["repo.read"], [], []),
		{"provider": "gitlab", "id": "acme/payments"},
		reads,
	)
	result.matchedPolicy == "mission-resource-scope"
}

test_scope_has_no_wildcard if {
	result := agentgate.decision with input as input_with(
		{"resources": ["github:acme/*"], "allowedActions": ["repo.read"], "approvalActions": [], "deniedActions": []},
		payments,
		reads,
	)
	result.matchedPolicy == "mission-resource-scope"
}
