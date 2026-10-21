---
type: ADR
id: "0236"
title: "One presentation of cited materials: Sources in messages, readable evidence, and recovery from Resources"
status: proposed
date: 2026-10-21
---

## Context

ADR 0231 gave the Workspace one record reader (`RecordPreview`), one
version-aware reference model (`ResourceReferenceChip` resolved through the
reference status store) and one search. ADR 0233 adopted AI Elements
`Sources` and `Inline Citation` for conversation-shaped presentation. Issue
#233 asks the materials surfaces to use them consistently. Three gaps remained:
a sent message listed its citations as a bare chip row, unlike the prototypes;
Task review named evidence it could not title by its record id and showed raw
fingerprint prefixes; and a gone or unreadable material offered no way to look
for it again.

## Decision

### 1. A message's citations are Sources

A sent message presents what it cites with `ReferenceSources`: the AI Elements
`Sources` disclosure, open by default, whose list keeps the name "References"
and holds the Task the message is about first, then one
`ResourceReferenceChip` per cited material. The trigger counts the sources
and, when any of them changed or no longer exists, says how many, so a
collapsed list still warns. Drafts keep their chip row (composer interface
unchanged, #232).

### 2. Evidence is named like every reference

The Task review evidence list and the evidence inspector use the same
`fallbackTitle` and `formatVersion` as references: never a record id, never a
raw fingerprint. The evidence inspector shows the record's kind, reads Workspace
events so a newer version is announced instead of swapped in, and still
reports only the revision the reader displayed (ADR 0230 §4).

### 3. Recovery points to Resources

When a material is gone or cannot be read, the resource and evidence panels
offer "Find in Resources", which opens the Resources view and keeps the
inspector stack, so the researcher can find the material or what replaced it
and come back. It is not offered from Resources itself. Retry stays beside a
failed read.

## Consequences

- Message citations, previews and review share one reader, one reference model
  and one vocabulary; the prototypes' Sources composition is now product UI.
- Uploads, richer renderers and DM attachments are still not offered: each
  needs its own capability decision.
- Inline numbered citations inside message bodies need the server to mark
  cited spans; until then citations are listed under the message.
