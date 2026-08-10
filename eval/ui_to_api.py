#!/usr/bin/env python3
"""
Convert a ComfyUI *UI graph* export (nodes[] + links[]) into the *API prompt*
format the dhee comfy runners consume (id -> {class_type, inputs}).

Why this exists: `comfy.minimax_h3_r2v` loads `cfg.workflowPath` and rewires it
by `class_type`, so it needs the API shape. A UI export cannot be dropped in.

The conversion is exact rather than heuristic:
  * link wiring comes from each node's own `inputs[]`, which carry the real
    input `name` and a `link` id — so a connected input becomes [originId, slot].
  * widget values come from zipping `widgets_values` against the inputs[]
    entries flagged `widget`, IN ORDER. Verified against BasicScheduler,
    MiniMaxH3SigmaShift, UNETLoader, ResolutionSelector, PathchSageAttentionKJ
    and CLIPLoader before being trusted.
  * MUTED nodes (mode 4) and Reroute/Note nodes are dropped, and anything that
    fed only from them is left unconnected exactly as the UI would.

Usage: ui_to_api.py <ui.json> <out-api.json>
"""
import json
import sys

# Nodes that never reach the API prompt.
SKIP_TYPES = {'Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode'}
MUTED_MODES = {2, 4}  # 2 = never/bypass, 4 = muted


def widget_names(node):
    return [i['name'] for i in (node.get('inputs') or []) if i.get('widget')]


def convert(ui):
    nodes = ui['nodes']
    alive = {
        n['id']: n for n in nodes
        if n.get('mode') not in MUTED_MODES and n.get('type') not in SKIP_TYPES
    }
    dropped = [(n['id'], n.get('type'), 'muted' if n.get('mode') in MUTED_MODES else 'skip-type')
               for n in nodes if n['id'] not in alive]

    # link id -> (origin_node_id, origin_slot)
    origin = {}
    for link in ui.get('links') or []:
        # [id, origin_node, origin_slot, target_node, target_slot, type]
        origin[link[0]] = (link[1], link[2])

    api = {}
    for nid, n in alive.items():
        inputs = {}
        # 1. connected inputs (including widgets that were converted to inputs)
        for slot in (n.get('inputs') or []):
            lid = slot.get('link')
            if lid is None:
                continue
            src = origin.get(lid)
            if src is None:
                continue
            src_id, src_slot = src
            if src_id not in alive:
                continue  # fed by a muted node — leave unconnected, as the UI does
            inputs[slot['name']] = [str(src_id), src_slot]
        # 2. widget values, positionally against the widget-flagged inputs
        names = widget_names(n)
        vals = n.get('widgets_values')
        if isinstance(vals, dict):
            for k, v in vals.items():
                inputs.setdefault(k, v)
        elif isinstance(vals, list):
            for name, val in zip(names, vals):
                if name in inputs:
                    continue  # a real link beats the stale widget value
                inputs[name] = val
        api[str(nid)] = {'class_type': n['type'], 'inputs': inputs}
    return api, dropped


def main():
    ui = json.load(open(sys.argv[1]))
    api, dropped = convert(ui)
    with open(sys.argv[2], 'w') as f:
        json.dump(api, f, indent=2, ensure_ascii=False)
    print(f'converted {len(api)} nodes -> {sys.argv[2]}')
    for nid, t, why in dropped:
        print(f'  dropped {nid:<5} {t:<28} ({why})')


if __name__ == '__main__':
    main()
