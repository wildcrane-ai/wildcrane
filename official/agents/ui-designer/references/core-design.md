# Core design

Read `references/rendered-screen.md` from this agent's folder for the rendering contract.

- **Direction**: show one product-consistent design on one whole key screen by default,
  preserving flow context and adding views only to judge the design or meet explicit coverage
  without automatically multiplying languages, devices and states.
- **Content**: reuse confirmed copy and assets when present; otherwise supply the content needed to judge this direction without claiming approval. Keep the output static and follow the rendering contract.
- **Approval**: submit this stage and stop. Revisions change only the core design; leave
  additional screens, states and adaptations to ui-draft after approval.
