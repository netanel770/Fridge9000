import { useCallback } from "react";
import { router } from "expo-router";
import ReceiptUpload from "../src/components/ReceiptUpload";

export default function ReceiptScreen() {
  const handleSubmitted = useCallback(() => {
    router.replace("/inventory");
  }, []);

  return <ReceiptUpload onSubmitted={handleSubmitted} />;
}
