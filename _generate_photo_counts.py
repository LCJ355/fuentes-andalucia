import os
import re
import json

def generate_photo_counts():
    images_dir = 'images'
    if not os.path.exists(images_dir):
        print(f"Error: Directory '{images_dir}' not found.")
        return

    # Pattern to match filenames: cf_ID_NUM.jpg
    pattern = re.compile(r'^cf_(\d+)_(\d+)\.(jpg|jpeg|png)$', re.IGNORECASE)
    counts = {}

    print("Scanning images directory...")
    for filename in os.listdir(images_dir):
        match = pattern.match(filename)
        if match:
            source_id = int(match.group(1))
            photo_num = int(match.group(2))
            
            # Keep track of the highest photo index seen (which represents the count, assuming sequential numbers starting from 1)
            # Or count unique files per source ID. Since they are 1-indexed, we can check the maximum number.
            if source_id not in counts:
                counts[source_id] = photo_num
            else:
                if photo_num > counts[source_id]:
                    counts[source_id] = photo_num

    # Write as JS file
    output_js = 'photo_counts.js'
    with open(output_js, 'w', encoding='utf-8') as f:
        f.write('window.PHOTO_COUNTS = ')
        json.dump(counts, f, ensure_ascii=False)
        f.write(';\n')
        
    print(f"Generated {output_js} with {len(counts)} source entries.")

if __name__ == '__main__':
    generate_photo_counts()
