import json
from pathlib import Path
import argparse

def process_json_file(json_path: Path, output_dir: Path):
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
        
    question = data["case_text"]
    filename = output_dir / Path(data["file_name"]).with_suffix(".txt").name

    with open(filename, "w", encoding="utf-8") as f:
        f.write(question)
            

def process_json_folder(json_dir: Path, output_dir: Path):
    for json_path in json_dir.glob("*.json"):
        print(f"Processing {json_path}")
        process_json_file(json_path, output_dir)

def main():
    parser = argparse.ArgumentParser()
    
    parser.add_argument(
        "--json-path",
        type=Path,
        help="Path to a JSON file or folder containing JSON files",
    )
    
    parser.add_argument(
        "--mode",
        choices=["file", "folder", "auto"],
        default="auto",
        help="How to interpret json_path"
    )
    
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("input"),
        help="Output directory"
    )
    
    args = parser.parse_args()
    
    args.output_dir.mkdir(parents=True, exist_ok=True)
    
    if args.mode == "file":
        process_json_file(args.json_path, args.output_dir)

    elif args.mode == "folder":
        process_json_folder(args.json_path, args.output_dir)

    elif args.mode == "auto":
        if args.json_path.is_file():
            process_json_file(args.json_path, args.output_dir)

        elif args.json_path.is_dir():
            process_json_folder(args.json_path, args.output_dir)

        else:
            raise FileNotFoundError(f"Path not found: {args.json_path}")


if __name__ == "__main__":
    main()