"""Opt-in live provider lanes.

``test_anthropic_model_catalogue`` reconciles the model allowlist, while
``test_resonance_yield`` measures marginalia yield and habit detection on an
invented journal fixture. Each lane has its own explicit environment opt-in;
ordinary pytest never performs provider traffic. An unarmed resonance lane is
deselected at collection (``conftest.py``), never skipped, so it cannot blur
the scheduled model check's skip-based "no verdict" signal.
"""
