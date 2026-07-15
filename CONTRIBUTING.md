# Contributing to Kubecode

Keep changes focused on the project-based Kubeflow web workspace. Before
submitting a change:

- add a regression test for behavior changes;
- use the existing shadcn components and semantic theme tokens;
- keep browser paths relative to `NB_PREFIX`;
- keep filesystem operations behind `WorkspaceService`;
- do not add provider credentials or model APIs to Kubecode;
- update the architecture documentation for structural changes.

Run the checks listed in [README.md](README.md#quality-checks). Bug reports
should include the commit, browser, deployment environment, reproduction steps,
and relevant server logs without credentials or project content.
