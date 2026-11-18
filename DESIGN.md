---
version: alpha
name: "PornGo"
description: "Win 8.1 inspired flat tile workspace for a single-screen Windows video downloader"
colors:
  canvas: "#21194d"
  canvas-deep: "#18123c"
  blue: "#0876ba"
  violet: "#6532a8"
  teal: "#007c77"
  magenta: "#ad306d"
  orange: "#c44c1d"
  download-blue: "#2e4799"
  amber: "#f4a619"
  white: "#ffffff"
  muted: "#d4d1e6"
  focus: "#fff06a"
typography:
  display:
    fontFamily: "Segoe UI, Microsoft YaHei UI, Microsoft YaHei, sans-serif"
  body:
    fontFamily: "Segoe UI, Microsoft YaHei UI, Microsoft YaHei, sans-serif"
rounded:
  DEFAULT: "0px"
spacing:
  tile-gap: "12px"
components:
  tile:
    radius: "0px"
  button:
    radius: "0px"
  dialog:
    radius: "0px"
---

# PornGo Design System

## Overview

### Creative North Star

The Windows 8.1 Start screen: large type, edge-to-edge saturated tiles, and motion that makes real activity legible. PornGo is a Chinese-language Windows desktop tool for people saving permitted videos. The one screen moves from link to content to destination to download progress.

### Product context and register

- **Audience and job:** Windows users paste a supported Pornhub URL, check the parsed content, and download to a chosen folder.
- **Locale and scene:** Simplified Chinese in a desktop Electron window. English appears only in small visual tile labels and the product name.
- **Register:** Product. The interface is expressive at the tile level and restrained inside fields, metadata, and progress details.
- **Signature:** The amber live tile cycles through the three supported content types; adjacent operation tiles react to state changes.
- **Anti-references:** Soft rounded cards, pink gradients, floating shadows, decorative glass, and motion that obscures a task.
- **Token mapping:** This file records the approved visual values. The matching CSS custom properties in `src/styles.css` are the single runtime token owner. Component rules consume those variables. Update both together when the system changes.

## Colors

The deep violet canvas frames flat colored work tiles. Blue means entering a link, violet means parsed content, teal means destination, magenta means account, download blue means concurrency settings and progress, and orange is the download action. Amber is reserved for the live tile and active session indicator. White text and the yellow focus ring stay visible on saturated tiles. Error, success, and disabled states retain text labels rather than relying on color.

The session indicator uses static amber when the visible account menu confirms a login, and labels that state as recently confirmed after the embedded window closes. Saved site data without a clear login signal stays neutral and does not claim the user is signed out.

## Typography

Segoe UI supplies the light Windows-style display headings; Microsoft YaHei UI and Microsoft YaHei keep Chinese text legible on Windows. Large headings use a light weight. Controls and status use regular or semibold weights. Small English tile labels are supplemental and never carry the only meaning.

## Layout

The desktop uses a broad work column and a narrow account/progress column with a 12px tile gap. The dark 54px application header is also the draggable window titlebar, with native-sized window actions at its right edge. The default 1060 × 780 window keeps the primary workflow visible without scrolling; the minimum window is 980 × 780. Tile padding and the live tile are compact so the workflow retains its sequence in the available height. Once content is parsed, the introductory panel gives way to the full content and quality controls. Longer notices, metadata, and active batch progress can scroll naturally. Progress, thumbnail, and directory surfaces reserve their dimensions as content arrives.

The compact download-concurrency tile appears after parsing in the space released by the introduction. Its two native selectors independently control fragment concurrency for one video and video concurrency for batches. Both default to one connection or worker so comparisons begin from the original behavior. The video selector is disabled for a single video; the fragment selector remains available for every content type.

## Elevation & Depth

Static tiles have no border, radius, or shadow. Color and placement establish hierarchy. Only the modal dialog casts a shadow to distinguish its blocking layer.

## Shapes

Tiles, controls, media frames, and dialog edges are square. The only round shapes are rotating busy dots and the tiny session status mark, whose geometry conveys activity.

## Components

### Foundational visual states

Buttons show hover brightness, pressed scale, visible keyboard focus, disabled opacity or a distinct muted fill, and rotating busy feedback. Form errors include text and an invalid input marker. Notices have app-owned success, information, and error treatments with live announcements. Progress remains textual beside the bar.

### Buttons and actions

White buttons are local tile actions. The orange full-width button starts downloading. Session clearing uses a separate confirmation dialog with explicit action labels and initial focus on the safe action.

### Navigation and data display

This release is a single-screen workflow. The numbered tiles reflect its real sequence: link, content, save location. Account and progress are supporting status tiles.

### Forms and overlays

The URL input has a visible clear control when populated. The quality selector keeps its native Windows popup because this desktop application accepts platform-owned option geometry. The app-owned session dialog uses the native HTML dialog's focus containment and Escape behavior, styled to match the tiles.

### Iconography

Simple text glyphs and geometric marks support labels; they do not replace action names. Icons stay visually aligned in square fields.

### Motion

Startup uses a brief rotating-dot indicator and tile pivot entrance. The live tile cycles calmly between supported content types. Busy actions spin until their operation ends; progress and session states breathe only while active. All motion stops under `prefers-reduced-motion`.

### Content and data visualization

Use direct Chinese verbs and useful status text. The download percentage is shown as a number and in a labeled progress bar. Failures say which action failed and preserve a retry path.

## Do's and Don'ts

- **Do:** Keep all new workflow surfaces in the flat tile language and update CSS tokens with this document.
- **Do:** Pair every animated state with a stable text status.
- **Don't:** Bring back rounded floating cards or gradients.
- **Don't:** Use rapid flashing, looping movement on primary task content, or color as the only status signal.
