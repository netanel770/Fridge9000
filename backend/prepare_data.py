import os
import shutil
import pandas as pd

# הגדירו את הנתיבים לפי המיקום אצלכם במחשב
DATASET_ROOT = "path/to/GroceryStoreDataset-master" # התיקייה שירדה מגיטהאב
OUTPUT_DIR = "fridge_data_cls"

# 1. טעינת שמות הקלאסים
classes_df = pd.read_csv(os.path.join(DATASET_ROOT, 'dataset', 'classes.csv'))
class_map = dict(zip(classes_df['Class ID'], classes_df['Class Name']))

def prepare_data(txt_file, subset_name):
    txt_path = os.path.join(DATASET_ROOT, 'dataset', txt_file)
    with open(txt_path, 'r') as f:
        for line in f:
            # הפורמט: path/to/img.jpg, fine_id, coarse_id
            parts = line.strip().split(',')
            img_rel_path = parts[0].strip()
            class_id = int(parts[1].strip())
            class_name = class_map[class_id].replace("-", "_") # ניקוי תווים בעייתיים
            
            # מקור ויעד
            src = os.path.join(DATASET_ROOT, 'dataset', img_rel_path)
            dst_dir = os.path.join(OUTPUT_DIR, subset_name, class_name)
            
            os.makedirs(dst_dir, exist_ok=True)
            if os.path.exists(src):
                shutil.copy(src, dst_dir)

print("Starting organization...")
prepare_data('train.txt', 'train')
prepare_data('val.txt', 'val')
print(f"Done! Data is ready in: {os.path.abspath(OUTPUT_DIR)}")