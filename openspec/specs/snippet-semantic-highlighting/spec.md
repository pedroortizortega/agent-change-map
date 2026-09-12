# Snippet Semantic Highlighting Specification

## Purpose

Replace the Snippet Draft panel's plain-text rendering with approximate-semantic Python coloring, combining AST-derived identifier roles with the workspace's active VS Code color theme.

## Requirements

### Requirement: Color draft text using AST-derived identifier roles and the active theme

The system MUST render the Snippet Draft editor/view content with color applied per identifier role — at minimum `self`, function/method parameter, class name, imported name, and builtin — derived from the analyzer's AST, mapped to color values sourced from the workspace's active VS Code color theme (`activeColorTheme` token/semantic colors). The system MUST NOT render the draft as a bare unstyled `<textarea>`/`<pre>`.

#### Scenario: Draft renders with role-colored identifiers

- GIVEN a Python snippet is shown in the draft view
- WHEN the AST identifies `self`, a parameter, a class name, an imported name, and a builtin in that snippet
- THEN each is rendered with a color derived from the active theme's token/semantic colors for that role, distinct from plain unstyled text

#### Scenario: Theme change updates rendered colors

- GIVEN the draft view is already rendering colored text
- WHEN the user's active VS Code color theme changes
- THEN the draft view's colors update to reflect the new theme without requiring a reselection of the node

#### Scenario: Unresolvable identifier role falls back gracefully

- GIVEN an identifier in the snippet has no determinable role from the AST
- WHEN the draft renders
- THEN that identifier is shown without role-specific coloring rather than causing a rendering failure or blocking display of the rest of the snippet
</content>
