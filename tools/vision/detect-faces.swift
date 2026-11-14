// detect-faces.swift — local face detection + landmarks via Apple Vision.
//
// Used by src/color-grading/analysis/face-detect.js. No network, no paid
// dependency: Vision ships with macOS. Compiled once by face-detect.js with
// `swiftc -O` and cached; can also be run directly:
//
//   swift tools/vision/detect-faces.swift frame1.png frame2.png
//
// Output (stdout, one JSON document):
//   { "engine": "apple-vision", "os": "...", "images": [
//       { "path", "width", "height", "error"?,
//         "faces": [ { "confidence", "landmarksConfidence",
//                      "bbox": {x,y,w,h},            // pixels, TOP-LEFT origin
//                      "roll","yaw",                 // radians or null
//                      "regions": { "faceContour": [[x,y],...], ... } } ] } ] }
//
// Coordinates are converted from Vision's bottom-left normalized space to
// top-left pixel space so JS can index the decoded RGB buffer directly.
// Vision returns face detection only. It does NOT return a skin mask; skin is
// isolated downstream (skin.js) from these landmarks plus a chroma qualifier.

import Foundation
import Vision
import CoreGraphics
import ImageIO

func loadImage(_ path: String) -> CGImage? {
  let url = URL(fileURLWithPath: path) as CFURL
  guard let src = CGImageSourceCreateWithURL(url, nil) else { return nil }
  return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

func pts(_ region: VNFaceLandmarkRegion2D?, _ w: Int, _ h: Int) -> [[Double]]? {
  guard let region = region else { return nil }
  let size = CGSize(width: w, height: h)
  return region.pointsInImage(imageSize: size).map { p in
    [Double(p.x), Double(h) - Double(p.y)]
  }
}

var images: [[String: Any]] = []
for path in CommandLine.arguments.dropFirst() {
  var entry: [String: Any] = ["path": path]
  guard let cg = loadImage(path) else {
    entry["error"] = "could not decode image"
    entry["faces"] = []
    images.append(entry)
    continue
  }
  let w = cg.width, h = cg.height
  entry["width"] = w
  entry["height"] = h

  let request = VNDetectFaceLandmarksRequest()
  let handler = VNImageRequestHandler(cgImage: cg, options: [:])
  do {
    try handler.perform([request])
  } catch {
    entry["error"] = "vision request failed: \(error.localizedDescription)"
    entry["faces"] = []
    images.append(entry)
    continue
  }

  var faces: [[String: Any]] = []
  for obs in request.results ?? [] {
    let bb = obs.boundingBox
    var face: [String: Any] = [
      "confidence": Double(obs.confidence),
      "bbox": [
        "x": Double(bb.minX) * Double(w),
        "y": (1.0 - Double(bb.maxY)) * Double(h),
        "w": Double(bb.width) * Double(w),
        "h": Double(bb.height) * Double(h),
      ],
      "roll": obs.roll.map { $0.doubleValue } as Any,
      "yaw": obs.yaw.map { $0.doubleValue } as Any,
    ]
    var regions: [String: Any] = [:]
    if let lm = obs.landmarks {
      face["landmarksConfidence"] = Double(lm.confidence)
      let named: [(String, VNFaceLandmarkRegion2D?)] = [
        ("faceContour", lm.faceContour), ("outerLips", lm.outerLips),
        ("innerLips", lm.innerLips), ("leftEye", lm.leftEye),
        ("rightEye", lm.rightEye), ("leftEyebrow", lm.leftEyebrow),
        ("rightEyebrow", lm.rightEyebrow), ("nose", lm.nose),
        ("leftPupil", lm.leftPupil), ("rightPupil", lm.rightPupil),
      ]
      for (name, region) in named {
        if let p = pts(region, w, h) { regions[name] = p }
      }
    } else {
      face["landmarksConfidence"] = NSNull()
    }
    face["regions"] = regions
    faces.append(face)
  }
  entry["faces"] = faces
  images.append(entry)
}

let doc: [String: Any] = [
  "engine": "apple-vision",
  "os": ProcessInfo.processInfo.operatingSystemVersionString,
  "images": images,
]
let data = try JSONSerialization.data(withJSONObject: doc, options: [])
FileHandle.standardOutput.write(data)
