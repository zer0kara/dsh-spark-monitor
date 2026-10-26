# Changelog

## 1.0.0

- Initial open-source release.
- Status-bar monitor for 1-4 DGX Spark nodes: aggregate temperature and memory pills with per-node hover details.
- Configurable hosts (SSH alias, label, temperature/memory switches) and clock tiers. No host is configured by default: nothing is sampled and the pills stay hidden until you add one.
- GPU clock tier control applied to every configured node (`nvidia-smi -lgc` / `-rgc`), with a per-node tier record.
- en / zh dictionaries, Desktop plugin-manager settings form, per-node failure isolation.