[README.md](https://github.com/user-attachments/files/28598381/README.md)
# OPTCG Meta Analyzer

A community training tool for the One Piece Trading Card Game.

## Features
- Meta ranking by weighted win rate
- Go 1st or 2nd? advisor with matchup-specific recommendations
- WR recalculated dynamically when decks are filtered
- Card image tooltips
- Default deck setting

## Data
Stats data is fetched automatically from OPTCG Sim ranked game data every 4 hours via GitHub Actions and cached in `/data/stats.json`. No manual updates needed.

## Setup (for contributors)
1. Fork this repo
2. Enable GitHub Pages: Settings → Pages → Deploy from branch → main → / (root)
3. The Actions workflow will populate data automatically on first run

## Updating for a new set
When a new set releases, update the `SET` variable in `.github/workflows/update-data.yml` from `op16` to `op17` (etc.).

---
*Data sourced from OPTCG Sim via cardkaizoku.com*
