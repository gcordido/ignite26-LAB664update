"""Switch lab.md images between VM markup and local Markdown previews."""

import argparse
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VM_FOLDER = "instructions359897"
IMAGE_MAP = {
    "chshn4cn.png": "list_of_samples.png",
    "xfe4ei8u.png": "pre_built_analyzer.png",
    "kke6gm3z.png": "custom_repair_extractor.png",
    "qm5a1m18.png": "advanced_settings.png",
    "y1l65rn4.png": "add_fields.png",
    "ctdjrztc.png": "run_analysis.png",
    "eli9ysmu.png": "build_analyzer.png",
    "22c2gk9p.png": "analyzer_list.png",
    "szpjguew.png": "custom_statement_extractor.png",
    "03cudcq2.png": "import_schema.png",
    "33b9kcoj.png": "hide_missing_fields.png",
    "516v1pe7.png": "updated_analyzer_list.png",
    "9maoqxjx.png": "classification_project.png",
    "7qhnpb5o.png": "add_categories.png",
    "9zacnykv.png": "segment_settings.png",
    "s51l89mw.png": "segmentation.png",
    "n0m86b6w.png": "download_result.png",
    "vcl16bde.png": "segment_pages.png",
    "1b7s3xw7.png": "add_analyzer.png",
    "ujvd6zg6.png": "add_categories_2.png",
    "bj0sbmti.png": "updated_routing_rules.png",
    "6cp63e2r.png": "input_segment_1.png",
}


def convert_images(content, mode):
    """Replace only mapped image references, preserving all other bytes."""
    count = 0
    for vm_name, local_name in IMAGE_MAP.items():
        vm = f"!IMAGE[{vm_name}]({VM_FOLDER}/{vm_name})".encode("ascii")
        local = f"![{vm_name}](../img/{local_name})".encode("ascii")
        source, target = (vm, local) if mode == "local" else (local, vm)
        count += content.count(source)
        content = content.replace(source, target)
    return content, count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "mode",
        choices=("local", "vm"),
        help="local: preview images from img; vm: restore lab references before committing",
    )
    args = parser.parse_args()
    lab = ROOT / "instructions" / "lab.md"

    try:
        original = lab.read_bytes()
        updated, count = convert_images(original, args.mode)
        if args.mode == "local":
            for vm_name, local_name in IMAGE_MAP.items():
                reference = f"!IMAGE[{vm_name}]({VM_FOLDER}/{vm_name})".encode("ascii")
                image = ROOT / "img" / local_name
                if reference in original and not image.is_file():
                    raise FileNotFoundError(f"Local image not found: {image}")
        if updated != original:
            lab.write_bytes(updated)
    except OSError as error:
        parser.exit(1, f"Error: {error}\n")

    print(f"{args.mode}: changed {count} image reference(s) in {lab}")


if __name__ == "__main__":
    main()
