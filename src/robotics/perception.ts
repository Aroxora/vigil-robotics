/**
 * Perception pipelines for LLM-based autonomous robotics.
 *
 * Computer vision and perception systems produce structured outputs
 * (bounding boxes, masks, keypoints, poses, scene graphs). These must
 * be translated into text descriptions for LLM consumption. This module
 * provides the full perception-to-text pipeline covering object detection,
 * segmentation, pose estimation, scene graphs, visual odometry, fiducial
 * detection, depth, optical flow, face/gesture recognition, and point
 * cloud registration.
 *
 * @module robotics/perception
 */

// ─── Object Detection ─────────────────────────────────────────────────

export interface DetectionBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectionResult {
  label: string;
  classId: number;
  confidence: number;
  bbox: DetectionBoundingBox;
  position3d?: { x: number; y: number; z: number };
  distanceEstimate?: number;
  trackingId?: number;
}

export interface ObjectDetectionOutput {
  detections: DetectionResult[];
  model: string;
  imageWidth: number;
  imageHeight: number;
  inferenceMs: number;
  timestamp: number;
}

export function detectionToText(det: DetectionResult): string {
  let out = `${det.label} bbox:(${det.bbox.x.toFixed(0)},${det.bbox.y.toFixed(0)},${det.bbox.width.toFixed(0)}x${det.bbox.height.toFixed(0)}) conf:${det.confidence.toFixed(2)}`;
  if (det.position3d) {
    out += ` pos3d:(${det.position3d.x.toFixed(2)},${det.position3d.y.toFixed(2)},${det.position3d.z.toFixed(2)})`;
  }
  if (det.distanceEstimate !== undefined) {
    out += ` dist:${det.distanceEstimate.toFixed(2)}m`;
  }
  if (det.trackingId !== undefined) {
    out += ` track:#${det.trackingId}`;
  }
  return out;
}

export function objectDetectionToText(output: ObjectDetectionOutput): string {
  if (output.detections.length === 0) return 'DETECTION: no objects detected.';
  const lines = [`DETECTION[${output.model}] ${output.imageWidth}x${output.imageHeight} ${output.detections.length} objects (${output.inferenceMs}ms):`];
  for (const det of output.detections) {
    lines.push(`  ${detectionToText(det)}`);
  }
  return lines.join('\n');
}

// ─── Segmentation ─────────────────────────────────────────────────────

export interface SegmentationMask {
  label: string;
  classId: number;
  confidence: number;
  areaPx: number;
  centroid: { x: number; y: number };
  maskFormat: 'polygon' | 'rle' | 'bitmap';
}

export interface SegmentationOutput {
  masks: SegmentationMask[];
  model: string;
  imageWidth: number;
  imageHeight: number;
  inferenceMs: number;
  timestamp: number;
}

export function segmentationToText(output: SegmentationOutput): string {
  if (output.masks.length === 0) return 'SEGMENTATION: no segments detected.';
  const lines = [`SEGMENTATION[${output.model}] ${output.masks.length} segments (${output.inferenceMs}ms):`];
  for (const m of output.masks) {
    lines.push(`  ${m.label} area:${m.areaPx}px centro:(${m.centroid.x.toFixed(0)},${m.centroid.y.toFixed(0)}) conf:${m.confidence.toFixed(2)}`);
  }
  return lines.join('\n');
}

// ─── Pose Estimation ──────────────────────────────────────────────────

export interface HumanKeypoint {
  name: string;
  x: number;
  y: number;
  z?: number;
  confidence: number;
}

export interface ObjectPose6D {
  label: string;
  translation: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  confidence: number;
}

export interface PoseEstimationOutput {
  humanKeypoints?: { personId: number; keypoints: HumanKeypoint[] }[];
  objectPoses?: ObjectPose6D[];
  model: string;
  inferenceMs: number;
  timestamp: number;
}

export function objectPoseToText(pose: ObjectPose6D): string {
  const t = pose.translation;
  const r = pose.rotation;
  return `${pose.label} T:(${t.x.toFixed(3)},${t.y.toFixed(3)},${t.z.toFixed(3)}) Q:(${r.x.toFixed(3)},${r.y.toFixed(3)},${r.z.toFixed(3)},${r.w.toFixed(3)}) conf:${pose.confidence.toFixed(2)}`;
}

export function poseEstimationToText(output: PoseEstimationOutput): string {
  const lines: string[] = [];
  lines.push(`POSE_EST[${output.model}] (${output.inferenceMs}ms)`);

  if (output.humanKeypoints && output.humanKeypoints.length > 0) {
    for (const person of output.humanKeypoints) {
      const kpts = person.keypoints
        .filter((k) => k.confidence > 0.5)
        .map((k) => `${k.name}(${k.x.toFixed(0)},${k.y.toFixed(0)})`);
      lines.push(`  Person#${person.personId}: ${kpts.join(', ')}`);
    }
  }

  if (output.objectPoses && output.objectPoses.length > 0) {
    for (const pose of output.objectPoses) {
      lines.push(`  ${objectPoseToText(pose)}`);
    }
  }

  return lines.join('\n');
}

// ─── Scene Graph ──────────────────────────────────────────────────────

export interface SceneGraphNode {
  id: string;
  label: string;
  attributes: Record<string, string>;
}

export interface SceneGraphEdge {
  sourceId: string;
  targetId: string;
  relation: string;
  confidence: number;
}

export interface SceneGraph {
  nodes: SceneGraphNode[];
  edges: SceneGraphEdge[];
  timestamp: number;
}

export function sceneGraphToText(graph: SceneGraph): string {
  if (graph.nodes.length === 0) return 'SCENE_GRAPH: empty.';
  const lines = [`SCENE_GRAPH (${graph.nodes.length} nodes, ${graph.edges.length} edges):`];
  lines.push('  Objects:');
  for (const n of graph.nodes) {
    const attrs = Object.entries(n.attributes).map(([k, v]) => `${k}=${v}`).join(' ');
    lines.push(`    ${n.id}: ${n.label} ${attrs}`);
  }
  if (graph.edges.length > 0) {
    lines.push('  Relations:');
    for (const e of graph.edges) {
      lines.push(`    ${e.sourceId} -[${e.relation} conf:${e.confidence.toFixed(2)}]-> ${e.targetId}`);
    }
  }
  return lines.join('\n');
}

// ─── Visual Odometry ──────────────────────────────────────────────────

export interface VisualOdometry {
  translation: { x: number; y: number; z: number };
  rotation: { roll: number; pitch: number; yaw: number };
  keypointsTracked: number;
  inliers: number;
  driftEstimate: number;
  timestamp: number;
}

export function visualOdometryToText(vo: VisualOdometry): string {
  const t = vo.translation;
  const r = vo.rotation;
  return `VO delta T:(${t.x.toFixed(3)},${t.y.toFixed(3)},${t.z.toFixed(3)})m R:(${r.roll.toFixed(3)},${r.pitch.toFixed(3)},${r.yaw.toFixed(3)})rad kpts:${vo.keypointsTracked} inliers:${vo.inliers} drift:${vo.driftEstimate.toFixed(3)}`;
}

// ─── Fiducial Detection ───────────────────────────────────────────────

export interface FiducialDetection {
  type: 'apriltag' | 'qr' | 'aruco' | 'artag' | 'custom';
  id: number;
  family: string;
  corners: { x: number; y: number }[];
  pose?: { translation: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number } };
  confidence: number;
  decodedData?: string;
}

export interface FiducialOutput {
  detections: FiducialDetection[];
  cameraId: string;
  timestamp: number;
}

export function fiducialToText(output: FiducialOutput): string {
  if (output.detections.length === 0) return 'FIDUCIAL: no tags detected.';
  const lines = [`FIDUCIAL[${output.cameraId}] ${output.detections.length} tags:`];
  for (const f of output.detections) {
    let line = `  ${f.type}/${f.family}#${f.id} conf:${f.confidence.toFixed(2)}`;
    if (f.pose) {
      const t = f.pose.translation;
      line += ` T:(${t.x.toFixed(3)},${t.y.toFixed(3)},${t.z.toFixed(3)})`;
    }
    if (f.decodedData) {
      line += ` data:"${f.decodedData}"`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

// ─── Depth Estimation ─────────────────────────────────────────────────

export interface DepthEstimationOutput {
  minDepth: number;
  maxDepth: number;
  meanDepth: number;
  medianDepth: number;
  variance: number;
  width: number;
  height: number;
  model: string;
  timestamp: number;
}

export function depthEstimationToText(output: DepthEstimationOutput): string {
  return `DEPTH_EST[${output.model}] ${output.width}x${output.height} min:${output.minDepth.toFixed(2)}m max:${output.maxDepth.toFixed(2)}m mean:${output.meanDepth.toFixed(2)}m median:${output.medianDepth.toFixed(2)}m σ²=${output.variance.toFixed(3)}`;
}

// ─── Optical Flow ─────────────────────────────────────────────────────

export interface OpticalFlowOutput {
  magnitudeMean: number;
  magnitudeStd: number;
  directionDominant: number;
  directionVariance: number;
  stationaryPct: number;
  width: number;
  height: number;
  timestamp: number;
}

export function opticalFlowToText(flow: OpticalFlowOutput): string {
  return `FLOW mag:${flow.magnitudeMean.toFixed(2)}±${flow.magnitudeStd.toFixed(2)}px dir:${flow.directionDominant.toFixed(1)}° stationary:${(flow.stationaryPct * 100).toFixed(0)}% ${flow.width}x${flow.height}`;
}

// ─── Face / Gesture Recognition ───────────────────────────────────────

export interface FaceDetection {
  bbox: DetectionBoundingBox;
  confidence: number;
  landmarks?: { name: string; x: number; y: number; confidence: number }[];
  attributes?: { age?: number; gender?: string; expression?: string; mask?: boolean };
  identity?: string;
  recognitionConfidence?: number;
}

export interface GestureDetection {
  name: string;
  confidence: number;
  hand: 'left' | 'right' | 'unknown';
}

export interface FaceGestureOutput {
  faces: FaceDetection[];
  gestures: GestureDetection[];
  timestamp: number;
}

export function faceGestureToText(output: FaceGestureOutput): string {
  const lines: string[] = [];
  if (output.faces.length > 0) {
    lines.push(`FACES (${output.faces.length}):`);
    for (const f of output.faces) {
      let line = `  conf:${f.confidence.toFixed(2)} bbox:(${f.bbox.x.toFixed(0)},${f.bbox.y.toFixed(0)},${f.bbox.width.toFixed(0)}x${f.bbox.height.toFixed(0)})`;
      if (f.identity) line += ` id:"${f.identity}" recConf:${(f.recognitionConfidence ?? 0).toFixed(2)}`;
      if (f.attributes?.expression) line += ` expr:${f.attributes.expression}`;
      if (f.attributes?.mask) line += ' MASK';
      lines.push(line);
    }
  }
  if (output.gestures.length > 0) {
    lines.push(`GESTURES (${output.gestures.length}):`);
    for (const g of output.gestures) {
      lines.push(`  ${g.hand} ${g.name} conf:${g.confidence.toFixed(2)}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : 'FACE/GESTURE: no detections.';
}

// ─── Point Cloud Registration ─────────────────────────────────────────

export interface PointCloudRegistration {
  source: string;
  target: string;
  transformation: { translation: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number } };
  fitness: number;
  inlierFraction: number;
  rmse: number;
  correspondenceCount: number;
  algorithm: 'ICP' | 'NDT' | 'FPFH' | 'Teaser' | 'custom';
  timestamp: number;
}

export function pointCloudRegistrationToText(reg: PointCloudRegistration): string {
  const t = reg.transformation.translation;
  const r = reg.transformation.rotation;
  return `REG[${reg.algorithm}] ${reg.source}→${reg.target} T:(${t.x.toFixed(3)},${t.y.toFixed(3)},${t.z.toFixed(3)}) Q:(${r.x.toFixed(3)},${r.y.toFixed(3)},${r.z.toFixed(3)},${r.w.toFixed(3)}) fit:${reg.fitness.toFixed(3)} inl:${reg.inlierFraction.toFixed(2)} rmse:${reg.rmse.toFixed(4)} corr:${reg.correspondenceCount}`;
}

// ─── Perception Aggregator ────────────────────────────────────────────

export interface PerceptionContext {
  objectDetection?: ObjectDetectionOutput;
  segmentation?: SegmentationOutput;
  poseEstimation?: PoseEstimationOutput;
  sceneGraph?: SceneGraph;
  visualOdometry?: VisualOdometry;
  fiducial?: FiducialOutput;
  depthEstimation?: DepthEstimationOutput;
  opticalFlow?: OpticalFlowOutput;
  faceGesture?: FaceGestureOutput;
  pointCloudRegistration?: PointCloudRegistration;
  timestamp: number;
}

/**
 * Aggregates all perception pipeline outputs into a single structured
 * text context for LLM consumption. Each pipeline contributes its own
 * section if data is available.
 */
export function composePerceptionContext(ctx: PerceptionContext): string {
  const lines: string[] = [];
  lines.push(`=== PERCEPTION CONTEXT @ ${new Date(ctx.timestamp).toISOString()} ===`);

  if (ctx.objectDetection) lines.push(objectDetectionToText(ctx.objectDetection));
  if (ctx.segmentation) lines.push(segmentationToText(ctx.segmentation));
  if (ctx.poseEstimation) lines.push(poseEstimationToText(ctx.poseEstimation));
  if (ctx.sceneGraph) lines.push(sceneGraphToText(ctx.sceneGraph));
  if (ctx.visualOdometry) lines.push(visualOdometryToText(ctx.visualOdometry));
  if (ctx.fiducial) lines.push(fiducialToText(ctx.fiducial));
  if (ctx.depthEstimation) lines.push(depthEstimationToText(ctx.depthEstimation));
  if (ctx.opticalFlow) lines.push(opticalFlowToText(ctx.opticalFlow));
  if (ctx.faceGesture) lines.push(faceGestureToText(ctx.faceGesture));
  if (ctx.pointCloudRegistration) lines.push(pointCloudRegistrationToText(ctx.pointCloudRegistration));

  return lines.join('\n');
}
