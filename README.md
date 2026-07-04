# Vigil Robotics — LLM-Based Autonomous Robotics Control

Production-grade robotics integration framework for grounding large language models in physical robot control. Multi-platform support for Boston Dynamics (Spot, Atlas), Universal Robots (UR5e, UR10e), KUKA LBR iiwa, ABB GoFa, Franka Emika Panda, Kinova Gen3, and all ROS-compatible platforms.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        LLM CONTEXT WINDOW                       │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐  ┌─────────────┐  │
│  │  SENSOR  │  │ SPATIAL  │  │ PERCEPTION │  │   CONTROL   │  │
│  │ CONTEXT  │  │ CONTEXT  │  │  CONTEXT   │  │   CONTEXT   │  │
│  └────▲─────┘  └────▲─────┘  └─────▲──────┘  └──────▲──────┘  │
├───────┼──────────────┼──────────────┼────────────────┼────────┤
│       │              │              │                │         │
│  ┌────┴──────────────┴──────────────┴────────────────┴────┐    │
│  │              sensor-to-text pipeline                    │    │
│  │  LIDAR · depth · camera · IMU · joints · F/T · audio   │    │
│  │  GPS · battery · thermal · diagnostic · proximity      │    │
│  └────────────────────────┬───────────────────────────────┘    │
│                           │                                    │
│                    ┌──────┴──────┐                             │
│                    │  LLM REASON  │                            │
│                    └──────┬──────┘                             │
│                           │                                    │
│  ┌────────────────────────┴───────────────────────────────┐    │
│  │              text-to-action pipeline                    │    │
│  │  ACTUATE:<robot>.<part>:<action>(param1=val1,...)      │    │
│  └────────────────────────┬───────────────────────────────┘    │
│                           │                                    │
│  ┌────────────────────────┴───────────────────────────────┐    │
│  │                 SAFETY GATEKEEPER                       │    │
│  │  joint limits · force limits · workspace bounds        │    │
│  │  collision check · emergency stop · watchdog           │    │
│  └────────────────────────┬───────────────────────────────┘    │
│                           │                                    │
│  ┌────────────────────────┴───────────────────────────────┐    │
│  │                    ACTUATORS                            │    │
│  │  joint · gripper · mobile · pan-tilt · LED · audio     │    │
│  │  tool I/O · camera trigger · display · cartesian       │    │
│  └────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

LLMs can only consume text tokens. Every sensor — LIDAR point clouds, stereo depth maps, camera images, IMU readings, joint encoder values, force/torque sensors, microphones — must be translated into structured text descriptions before the LLM can reason about the physical world. This framework provides the complete pipeline.

## Modules

### `src/robotics/sensor.ts` — Sensor-to-Text Pipeline
Translates all robot sensors into structured text for LLM consumption:
- **LIDAR**: Point cloud → cluster count, centroids, density, bounding boxes, range statistics
- **Depth (Stereo/RGBD)**: Depth maps → mean/min/max depth, range distribution
- **Camera**: Images → structured metadata (detected objects, scene label, brightness, motion)
- **IMU**: Orientation quaternion, angular velocity, linear acceleration (all with covariance)
- **Joint State**: Position, velocity, effort per joint name
- **Force/Torque**: 6-DOF wrench (force + torque vector)
- **Microphone**: Audio level, voice activity, event labels, transcription
- **Proximity/Range**: Distance, signal strength, field of view
- **Thermal**: Temperature range, hot spot detection
- **GPS**: Latitude, longitude, altitude, fix quality, HDOP/VDOP
- **Battery**: Percentage, voltage, current, state of health, time remaining
- **Diagnostics**: CPU, memory, comm latency, error/warning flags

### `src/robotics/actuator.ts` — Text-to-Action Protocol
Parses structured commands from LLM output: `ACTUATE:<robot>.<part>:<action>(param1=val1,param2=val2)`
- Joint position/velocity/torque commands
- Cartesian pose and trajectory commands
- Gripper control (open, close, grasp, release, set_position, set_force)
- Mobile base velocity commands (cmd_vel)
- Head/pan-tilt positioning
- LED patterns, display content
- Audio/speech output
- Tool I/O (digital, analog, PWM)
- Camera trigger controls
- Includes full validation against platform capabilities

### `src/robotics/navigation.ts` — Spatial Reasoning
Full spatial context for LLM motion planning:
- **Pose**: 6-DOF with full 6x6 covariance matrix
- **Waypoint**: Labeled poses with position/orientation tolerances and actions
- **Obstacle**: Typed obstacles (static, dynamic, human, vehicle) with geometry, velocity, TTL
- **Path**: Waypoints with cost, planner metadata
- **Occupancy Grid Map**: 2D grid with resolution, origin, frame
- **Costmap**: Inflation radius, lethal threshold
- **Localization**: Pose estimate with covariance, convergence score
- **SLAM Context**: Algorithm state, loop closures, keyframes, uncertainty
- **GPS Waypoint Following**: Lat/lon/alt with arrival radii

### `src/robotics/safety.ts` — Safety Layer
Every actuator command passes through safety validation:
- **Operational Envelope**: Joint limits, workspace boundaries, velocity/force caps
- **Emergency Stop**: Graceful, hard, or power-off stop
- **Collision Check**: Self-collision pairs, environment collision, trajectory prediction
- **Force Limits**: Per-joint and per-axis force/torque caps with rate limits
- **Safety-Rated Monitoring**: Configurable rates for SIL 1-3
- **Watchdog**: Heartbeat-based with consecutive miss detection
- **Safety Check Aggregation**: Scoring, severity levels, pass/fail

### `src/robotics/ros.ts` — ROS Integration
- **Topics**: Name, message type, QoS, latch, publisher/subscriber counts
- **Services**: Name, service type, timeout
- **Actions**: Name, action type, feedback rate, state tracking
- **Nodes**: Topic/service/action subscriptions and publications
- **Parameters**: Typed parameters with read-only flag
- **TF2 Transforms**: Full tree context builder with text translation
- **URDF**: Robot model parser (links, joints, end-effectors)
- **ROSbag**: Recording/playback configuration
- `toRosContext()` builds complete LLM-readable ROS graph state

### `src/robotics/hardware.ts` — Hardware Abstraction
- **Robot Platform Registry**: spot, atlas, ur5e, ur10e, kuka_iiwa, abb_gofa, franka_panda, kinova_gen3, custom
- **Manipulator**: Joint count, reach, payload, IK solver type, self-collision pairs
- **Mobile Base**: Differential, omnidirectional, Ackermann, legged
- **End Effector**: Gripper, suction, welding, camera, custom (payload, stroke, grip force)
- **Sensor Suite**: Sensor specifications with mounting frames and transforms
- **Capability Checking**: Validates commands against platform limits (velocity, torque, payload, reach)

### `src/robotics/perception.ts` — Perception Pipelines
- **Object Detection**: YOLO/Detectron outputs → text with bounding boxes, confidence, 3D position
- **Segmentation**: Instance/semantic masks → area, centroid, label
- **Pose Estimation**: 6D object poses, human keypoints (17+ points)
- **Scene Graph**: Nodes (objects) + edges (relations with confidence)
- **Visual Odometry**: Translation/rotation deltas with drift estimate
- **Fiducial Detection**: AprilTag, QR, ArUco with decoded data and 6D poses
- **Depth Estimation**: Min/max/mean/median with variance
- **Optical Flow**: Magnitude, direction, stationary percentage
- **Face/Gesture Recognition**: Landmarks, attributes, expressions, hand gestures
- **Point Cloud Registration**: ICP/NDT transformation with fitness scores

### `src/robotics/simulation.ts` — Simulation Bridge
- **Simulator Config**: Gazebo, Isaac Sim, PyBullet, MuJoCo, Webots, Coppelia
- **Simulated Robot**: Spawn pose, controller plugin, sensor plugins
- **Sim World**: Models, lights, physics properties
- **Domain Randomization**: Lighting, textures, physics, camera noise ranges
- **Sim-to-Real Transfer**: Observation/action noise, latency, calibration offsets
- **Simulation State**: Time, realtime factor, collision count, FPS

### `src/robotics/control.ts` — Control & Motion Planning
- **Trajectory Generation**: Joint space, Cartesian, cubic/quintic/minimum jerk/trapezoidal
- **Inverse Kinematics**: Analytic, numerical (LMA, Trac-IK) with redundancy resolution
- **Motion Planning**: OMPL, MoveIt, STOMP, CHOMP, SBPL, PRM, RRT/RRT*
- **PID Controllers**: Configurable gains, anti-windup, feedforward
- **MPC**: Horizon, state/input weights, solver tolerance
- **Impedance Control**: Stiffness + damping in 6 DOF
- **Admittance Control**: Mass + damping, force deadband
- **Hybrid Position/Force Control**: Selection matrix per axis

## MCP Servers

### `ros:mcp` — ROS MCP STDIO Server
```
npm run ros:mcp
```
Bridges LLM reasoning with a running ROS system. Tools:
- `ros_topic_list` — List all topics with types and pub/sub counts
- `ros_topic_echo` — Read messages from a topic
- `ros_service_call` — Call ROS services
- `ros_param_get` / `ros_param_set` — Read/set parameters safely
- `ros_tf_lookup` — Look up TF transformations between frames
- `ros_node_info` — Get node information
- `ros_urdf_load` — Load and parse URDF robot models

Connects via `ROS_MASTER_URI` (ROS 1) or `ROS_DOMAIN_ID` (ROS 2).

### `gazebo:mcp` — Gazebo MCP Server
```
npm run gazebo:mcp
```
Bridges LLM reasoning with simulated physics:
- `gazebo_spawn_model` — Spawn URDF/SDF models at poses
- `gazebo_delete_model` — Remove models
- `gazebo_set_pose` / `gazebo_get_pose` — Manipulate/query model poses
- `gazebo_apply_force` — Apply forces/torques to links
- `gazebo_reset_world` — Reset simulation
- `gazebo_pause` / `gazebo_step` — Pause/unpause or step through simulation

### `safety:mcp` — Robot Safety MCP Server
```
npm run safety:mcp
```
Safety validation accessible to the LLM for pre-action checks:
- `safety_check_limits` — Joint, workspace, velocity, force, torque checks
- `safety_watchdog_status` — Heartbeat monitoring
- `safety_emergency_stop` — Trigger stop (blocks all actuators)
- `safety_release_stop` — Release stop after verification
- `safety_set_velocity_limit` / `safety_set_force_limit` — Configure safety caps

## Public Agent Tools

```typescript
// Sensor tools
readSensor(suite, state)       // Read all sensors from a suite
querySensor(filter, state)     // Query specific sensor types
describeScene(state)           // Natural language scene description
getRobotState(state)           // Structured JSON robot state

// Actuator tools
executeActuatorCommands(text)  // Parse and execute ACTUATE: protocol
executeJointCommand(name, rad) // Move a single joint
executeTrajectory(type, wps)   // Execute a trajectory
controlGripper(action, w, f)   // Control gripper
moveBase(lx, ly, az, dur)      // Command mobile base
setEndEffector(x,y,z,r,p,y)    // Set Cartesian end-effector pose

// Navigation tools
planPath(start, goal, obs)     // Plan path with obstacle avoidance
followWaypoints(wps, env)      // Generate waypoint instructions
getSpatialContext(ctx, mode)   // Get spatial context text
checkCollision(start, goal)    // Check trajectory for collisions

// Safety tools
checkSafety(joints, tcp, ...)  // Comprehensive safety check
emergencyStop(reason, type)    // Trigger emergency stop
releaseStop(stop, checks)      // Release emergency stop
getOperationalEnvelope(env)    // Get envelope as text context
```

## Platform Support

| Platform | Type | DOF | Reach | Payload | Interfaces |
|----------|------|-----|-------|---------|------------|
| Boston Dynamics Spot | Quadruped | 14 | N/A | 14 kg | ROS 2, gRPC |
| Boston Dynamics Atlas | Humanoid | 28 | 0.9 m | 15 kg | ROS 2 |
| Universal Robots UR5e | Arm | 6 | 0.85 m | 5 kg | ROS 1/2, RTDE |
| Universal Robots UR10e | Arm | 6 | 1.3 m | 10 kg | ROS 1/2, RTDE |
| KUKA LBR iiwa 7/14 | Arm | 7 | 0.82 m | 7/14 kg | ROS 1/2, FRI |
| ABB GoFa 5/10 | Arm | 6 | 0.95 m | 5/10 kg | ROS 2, EGM |
| Franka Emika Panda | Arm | 7 | 0.855 m | 3 kg | ROS 1/2, libfranka |
| Kinova Gen3 | Arm | 7 | 0.902 m | 4 kg | ROS 1/2, Kortex |
| Custom/ROS-compatible | Any | — | — | — | ROS 1/2 |

## Safety Architecture

```
LLM COMMAND → capabilityCheck() → safety validation → EXECUTE
                  ↓                      ↓
            platform limits      checkJointLimits()
            reach/payload        checkWorkspaceBoundary()
            action support       checkForceLimit()
                                 checkCollisionRisk()
                                 isEmergencyStopActive()
```

Every actuator command is validated against:
1. **Platform capabilities** — Does this robot support this action? Is the value within hardware limits?
2. **Operational envelope** — Joint limits, workspace boundaries, velocity/force caps
3. **Collision risk** — Self-collision pairs, predicted trajectory collisions
4. **Emergency state** — Is emergency stop active? Has the watchdog expired?

## Repository Layout

```
src/
├── robotics/
│   ├── sensor.ts        # Sensor-to-text pipeline (all sensor types)
│   ├── actuator.ts      # Text-to-action protocol & validation
│   ├── navigation.ts    # Spatial reasoning & path planning types
│   ├── safety.ts        # Safety layer (SIL, limits, estop, watchdog)
│   ├── ros.ts           # ROS 1/2 integration (topics, services, TF, URDF)
│   ├── hardware.ts      # Hardware abstraction (platform registry)
│   ├── perception.ts    # CV/ML perception pipelines → text
│   ├── simulation.ts    # Simulation bridge (Gazebo, Isaac, MuJoCo)
│   ├── control.ts       # Control theory & motion planning
│   └── index.ts         # Re-exports
├── tools/public/
│   ├── sensorRead.ts    # Public sensor querying tools
│   ├── actuate.ts       # Public actuator execution tools
│   ├── navigate.ts      # Public navigation tools
│   ├── safety.ts        # Public safety tools
│   └── index.ts         # Re-exports
scripts/
├── ros-mcp.mjs          # ROS MCP stdio server
├── gazebo-mcp.mjs       # Gazebo simulation MCP server
└── robot-safety-mcp.mjs # Safety monitoring MCP server
agents/
└── vigil-code.rules.json # Robotics control agent rulebook
```

## Running

```bash
npm install
npm run build
npm link
vigil --key sk-...

# MCP servers (run in separate terminals)
npm run ros:mcp
npm run gazebo:mcp
npm run safety:mcp
```

## License

MIT
