# Conversation project reads and scoped context

The host supplies `ProjectAssistantOptions.integrations`; the assistant creates no credentials, connectors or network clients. A project must have host-registered `repo` and `teamKey` identities before integration tools are offered. Every call first validates the actual Slack audience and the project’s shared-channel allowlist. Private DM authority remains owner-only. The model cannot supply a repository, workspace, requester, root or credential.

Existing pinned `project_read` / `project_search` tools retain their exact admitted revision and file list. New `repository_revision`, `repository_read` and `repository_search` use `createLocalRepositoryReader` with host-reviewed root-to-repository registrations. They read regular tracked blobs at the observed local `HEAD`, exclude working-tree edits, reject symlinks/secret paths, and disable Git network transports and lazy fetches. Results label local revision, observation time and unverified upstream freshness. Reads paginate by line; search caps scanning at 2 MiB / 300 files, 30 matches and eight seconds and reports coverage/truncation. A partial miss is not evidence of absence. The callback cannot switch to an unrelated checkout.

`ticket_detail` reuses the existing Linear adapter. It checks the registered team prefix and the returned ticket identity before reading comments. Description pages include acceptance criteria when present in the description, up to 400 lines / 24 KB. A returned `nextLine` supports continuation. The first 20 comments are returned as bounded previews; a returned comment ID plus `startLine` selects a full comment page. An extra fetched comment establishes truncation. The existing adapter supplies blocked-by relations only; the response names that limitation and omits details of relations outside the registered team. Neither ticket state nor fetch time proves worker liveness.

`controller_status` and owner-only `controller_handoff` delegate to the existing controller callback. The helper does not dispatch coding work, create an owner or spending pool, clear a stop, or claim an accepted request has started. The controller independently rechecks admission, ownership, current stop and spending evidence. Historical `current_work` is kept separate.

Each turn automatically receives recent notes from its existing project/audience memory scope. DM notes never enter shared context; shared notes stay in the same channel and project. The visible `gary-role` project’s admitted pinned `voice.md` is loaded as a voice reference with provenance. Source text, notes and proposed skills remain contextual data and cannot grant permission.

Successful read-tool results can be captured through `recordEvidence`. The additive `project_conversation_evidence` table uses the existing private project-memory database. Captures are bound to exact audience, project and thread, and labeled historical, with observation/capture provenance. Larger captures have an explicitly incomplete JSON preview, result size and SHA-256. The cache holds at most 12 query keys per thread and 512 total; it refreshes existing keys and skips optional new captures at capacity. It never deletes or modifies user notes, canonical actions, spending receipts or delivery receipts. Context includes the latest two captures per project and stays below 64 KB; `contextTruncated` reports omitted optional context. Current-state questions must refresh the underlying read.

Host composition:

```ts
new ProjectAssistant({
  ...projectConfig,
  currentWork: createCurrentWorkReader(db, projectConfig.projects),
  integrations: {
    ticketDetail: createLinearTicketReader(existingLinear),
    repositoryProjectIds: reviewedLocalRepositoryRegistrations.map(project => project.projectId),
    repository: createLocalRepositoryReader(reviewedLocalRepositoryRegistrations),
    controller: createConversationController(existingControllerDependencies),
  },
});
```

Missing roots or unavailable adapters produce finite capability errors, not a fallback to other files, credentials or providers. Integration calls share the turn’s cancellation signal and have a 12-second boundary. This does not add persistent external access, recipients, upstream writes or monetary authority.
