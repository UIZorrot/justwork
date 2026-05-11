# Workspace Document Types Design

> **Goal:** keep the existing Markdown document type intact, and add two new first-class workspace document types: Table and Board. The product should feel like a Youshu/yuque-style workspace with multiple document kinds, not a single Markdown editor with plugins bolted on.

## Problem Statement

Today the workspace is centered on Markdown pages. That is good for prose, notes, and long-form documentation, but it is not enough for office-style work where structure matters:

- tabular data needs rows, columns, filters, and bulk editing
- multi-dimensional boards need grouped cards, fields, and status flow
- users still need a normal Markdown document type for writing

The workspace therefore needs multiple document kinds, each with its own editing surface, while sharing the same workspace-level collaboration and permissions model.

## Goals

- Keep the current Markdown document type as a first-class option.
- Add a first-class Table document type.
- Add a first-class Board document type.
- Make the three types visible in creation flows and in document lists.
- Preserve shared workspace behaviors such as membership, comments, mentions, notifications, and tasks as common infrastructure.
- Avoid forcing table or board content through Markdown as the canonical storage format.

## Non-Goals

- Replacing Markdown pages with table or board pages.
- Introducing PDF or Word as primary document types.
- Solving every collaboration feature in the first release.
- Designing a full spreadsheet clone.
- Designing a full project-management suite.

## Current Context

The codebase already has:

- a Markdown-first workbench and editor flow
- collaborative Markdown editing via Vditor and Yjs
- workspace-level membership and message plumbing
- backend workspace item persistence that currently assumes a Markdown body for normal document pages

This design keeps that existing Markdown path working unchanged for normal documents. The new types are additive, not a replacement.

## Recommended Direction

Use three parallel workspace document kinds:

1. **Document**: the current Markdown page type
2. **Table**: a structured record collection with a table editing surface
3. **Board**: a structured record collection with a grouped card surface

My recommendation is to make **Table** and **Board** separate document kinds in the UI, but let them share a structured data substrate underneath. In other words:

- they are different document types to users
- they can share the same record model, revision model, and collaboration plumbing
- they should not both be implemented as Markdown variants

This gives you the product clarity you want without fragmenting the backend architecture.

## Document Type Definitions

### 1. Document

The existing Markdown page remains the default type.

Characteristics:

- freeform prose, headings, lists, code blocks, images, links
- collaborative Markdown editing continues to work as it does today
- best for notes, specs, narratives, and long-form writing

UI:

- `New Document` creates this type
- document list shows it as a normal page

### 2. Table

The Table type is a structured document whose primary interaction is a grid.

Characteristics:

- rows are records
- columns are fields
- supports sorting, filtering, and bulk editing
- cells should allow richer content than plain text where practical
- should feel like a workspace-native data table, not an exported spreadsheet file

What it is for:

- task tracking
- contact lists
- asset inventories
- planning sheets
- lightweight operational data

### 3. Board

The Board type is a structured document whose primary interaction is cards grouped into lanes.

Characteristics:

- cards are records
- lanes are derived from a chosen field, usually status
- the board can expose multiple fields on each card
- the board should support filtering and sorting
- the board should feel like a multi-dimensional kanban, not just sticky notes on columns

What it is for:

- task flow
- approvals
- issue triage
- editorial pipelines
- planning boards

## Shared Data Model

Table and Board should share a common structured substrate.

Recommended shared primitives:

- `Document`
  - `id`
  - `kind`
  - `title`
  - `parentId`
  - `revision`
  - `createdAt`
  - `updatedAt`
- `Record`
  - `id`
  - `fields`
  - `createdAt`
  - `updatedAt`
- `FieldDefinition`
  - `id`
  - `name`
  - `type`
  - `config`

Table uses the record model directly as rows.
Board uses the same record model, with a grouped visual projection.

The key point is that the table and the board should not each invent a separate data model unless the implementation later proves that necessary.

## Rich Text Boundary

The product should remain rich-text-friendly underneath the structured views.

That does not mean Markdown is the universal storage format. It means:

- Markdown stays the source format for the Document type
- Table cells and Board cards can use a richer content model than plain strings
- the implementation should leave room for mentions, links, formatting, and comments inside structured content where it helps office workflows

If a field needs only plain text in the first release, that is acceptable. The model should still be able to grow into richer content without a format migration.

## Creation Flow

The homepage / workspace creation UI should expose exactly these three creation actions:

- `New Document`
- `New Table`
- `New Board`

Rules:

- `New Document` keeps the current Markdown behavior
- `New Table` creates a Table document
- `New Board` creates a Board document
- the three actions must be visible together so the user does not have to infer the type from a template or secondary menu

This is important for product clarity: the user should think in terms of document kinds, not hidden templates.

## Navigation and Discovery

The workspace list should show the document kind explicitly.

Recommended UI cues:

- a small type badge or icon next to the title
- type-based empty states for new Table and Board pages
- type-aware sort/filter in the workspace list later, if needed

The current Markdown pages must keep their existing behavior and should not be relabeled as Table or Board.

## Collaboration and Workspace Controls

The following should remain shared workspace-level capabilities rather than type-specific features:

- members / presence
- comments
- `@` mentions
- messages
- tasks

For the first release of the new document types, it is enough that these capabilities exist as workspace primitives and can be surfaced in the shell. They do not all need to be deeply integrated into every field or card on day one.

Recommended sequencing:

1. keep the current workspace member and message shell
2. add type-aware documents
3. extend comments / mentions / tasks into Table and Board content later

## Phased Rollout

### Phase 1

- keep Markdown documents unchanged
- add Table documents
- add Board documents
- expose the three creation buttons
- show document type in lists and empty states

### Phase 2

- improve field editing for Table and Board
- add richer cell/card content where needed
- add type-specific filtering, grouping, and sorting
- connect comments, mentions, and tasks more deeply into structured content

### Phase 3

- add more document kinds if the product proves they are worth the complexity
- likely candidates are Calendar, Gallery, and Timeline

## Risks

- Table and Board can easily become overbuilt if they are treated as separate mini-apps rather than shared document kinds.
- If the structured substrate is too weak, the product will feel fragmented and hard to evolve.
- If Markdown is accidentally made the default for everything, Table and Board will become second-class features.
- If the collaboration layer is overcoupled to any one document type, later expansion will be expensive.

## Testing Expectations

The first implementation pass should be considered complete only if:

- creating a Markdown document still works
- creating a Table document works
- creating a Board document works
- reopening each type restores the correct editor/view
- the document list preserves the type distinction
- workspace member / message features continue to work for the existing Markdown path

## Open Questions

These are implementation details to resolve later, not blockers for the current product decision:

- whether Table and Board use the same record schema on disk or separate schemas with adapters
- whether rich content inside cells/cards starts as plain text or serialized rich text
- whether type conversion between Document, Table, and Board should be supported in v1

## Decision

Proceed with three first-class document kinds:

- **Document** for Markdown pages
- **Table** for structured grid-style content
- **Board** for structured kanban-style content

Keep the current Markdown path intact. Do not remove it, rename it, or hide it behind the new types.
