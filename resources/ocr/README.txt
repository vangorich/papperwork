Paperwork PDF Studio - Local OCR assets

Engine: PaddleOCR / PP-OCRv6 Small (ONNX)
Runtime: paddleocr.js + Microsoft ONNX Runtime

Model sources:
- https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx
- https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx
- https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models

SHA-256:
- PP-OCRv6_small_det_infer.onnx
  D73E0058B7A8086BBD57F3D10B8BCD4FF95363F67E06E2762B5E814FE9C9410E
- PP-OCRv6_small_rec_infer.onnx
  5435FD747C9E0EFE15A96D0B378D5BD157E9492ED8FD80EDF08F30D02FA24634
- ppocrv6_dict.txt
  41557512862DFE31970CF22407742B629725461DD84C0D8771BDE9C87C2202C8

PaddleOCR model assets are distributed under the Apache License 2.0.
paddleocr.js is MIT licensed. Microsoft ONNX Runtime is MIT licensed.

Production profiles (optional, detected automatically)
------------------------------------------------------
The Small profile above remains bundled so OCR works offline without adding
hundreds of megabytes to every installer. To enable the requested production
profiles, place these files beside this README before packaging:

- PP-OCRv6_medium_det_infer.onnx
  upstream: detection/PP-OCRv6_medium_det.onnx
  size: 62032837 bytes
  sha256: EB13B44B25BB36F89528B68720AF8A61D9CF381176107F465DB1757B65D086E1
- PP-OCRv6_medium_rec_infer.onnx
  upstream: recognition/PP-OCRv6_medium_rec.onnx
  size: 76554979 bytes
  sha256: 9C09ABF0957F7968C7586464B7397B84AD2387A0497A351AF40E9ACC71B673BA
- PP-OCRv5_server_rec_infer.onnx
  upstream: recognition/PP-OCRv5_server_rec_infer.onnx
  size: 84176681 bytes
  sha256: C8CFF87FD83A76B97178250653924598593088C6BB71B2D2D942EF13B9A2D2EC
- ppocrv5_dict.txt
  upstream: recognition/ppocrv5_dict.txt

Source repository:
https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models

PaddleOCR-VL 1.6 runs as a separate local service because it is not a compact
ONNX text model. Configure its localhost JSON endpoint in Settings > OCR. The
application sends the full page only for the complex-document route; fallback
checks send at most 24 low-confidence local crops and always retain raw text.
