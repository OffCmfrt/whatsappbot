---
name: compactchat
description: Compact and summarize long conversations by extracting key information, decisions, and action items. Use when the user invokes /compactchat or asks to summarize, compress, or compact the current conversation.
---

# Compact Chat

## Purpose
Reduce lengthy conversations to essential context while preserving critical information, decisions, and pending tasks.

## Instructions

1. **Analyze the conversation** to identify:
   - Key decisions made
   - Important technical details and code changes
   - Pending tasks or action items
   - Critical context that must be preserved

2. **Generate a structured summary** containing:
   - Brief overview of what was discussed
   - Key decisions and their rationale
   - Code changes or modifications made (file paths and brief descriptions)
   - Current status and next steps
   - Any important constraints or requirements mentioned

3. **Format the summary** using this template:

```markdown
# Conversation Summary

## Overview
[2-3 sentence summary of the main topic/goal]

## Key Decisions
- Decision 1: [What and why]
- Decision 2: [What and why]

## Changes Made
- [file/path]: [Brief description of change]
- [file/path]: [Brief description of change]

## Current Status
[What's been completed, what's in progress]

## Next Steps
- [ ] Action item 1
- [ ] Action item 2

## Important Context
[Any constraints, requirements, or critical details to remember]
```

4. **Be concise but complete** - prioritize:
   - Technical decisions and their rationale
   - File modifications and their purpose
   - Errors encountered and solutions
   - User preferences and requirements

5. **Omit**:
   - Trial-and-error attempts that didn't work
   - Redundant clarifications
   - Tool outputs that aren't critical
   - Conversational pleasantries

## Example

**Input**: A 50-message conversation about refactoring authentication
**Output**:
```markdown
# Conversation Summary

## Overview
Refactored authentication system from session-based to JWT tokens, including login, registration, and middleware updates.

## Key Decisions
- JWT over session: Better scalability for distributed systems
- 24h token expiry: Balance between security and UX
- Refresh token rotation: Prevent token theft replay attacks

## Changes Made
- src/middleware/auth.js: Replaced session validation with JWT verification
- src/routes/authRoutes.js: Updated login/register endpoints to issue JWTs
- src/config/auth.js: Added JWT secret and expiry configuration
- package.json: Added jsonwebtoken dependency

## Current Status
Authentication refactoring complete, all endpoints updated

## Next Steps
- [ ] Add token refresh endpoint
- [ ] Update frontend to store JWT in httpOnly cookies
- [ ] Add integration tests for auth flow

## Important Context
- User prefers httpOnly cookies over localStorage for security
- Must maintain backward compatibility during rollout
- JWT secret stored in .env as JWT_SECRET
```

## When to Use
- User explicitly requests /compactchat
- User asks to summarize or compress the conversation
- Conversation has become very long and context needs consolidation
