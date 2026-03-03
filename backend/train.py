from ultralytics import YOLO
import torch

def train_model():
    # בדיקה אם יש לכם GPU של NVIDIA זמין
    device = 0 if torch.cuda.is_available() else 'cpu'
    print(f"Using device: {device}")

    # טעינת מודל סיווג (Classification)
    model = YOLO("yolo11n-cls.pt")

    # אימון
    model.train(
        data="fridge_data_cls", # התיקייה שיצרנו בשלב הקודם
        epochs=30,
        imgsz=224,
        device=device,
        workers=4 # מספר ליבות המעבד לטעינת נתונים
    )

if __name__ == '__main__':
    train_model()