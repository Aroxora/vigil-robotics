# Vigil Robotics — LLM-Based Autonomous Robotics Control

Sensor-to-text pipeline for grounding large language models in physical robot control. Designed for Boston Dynamics Spot, Atlas, and ROS-compatible platforms.

## Architecture

```
SENSORS (LIDAR, camera, IMU, joints) 
    → sensor-to-text translation 
    → LLM context window (text tokens)
    → LLM reasoning (next-token prediction) 
    → text-to-action parsing 
    → ACTUATORS (motors, servos, grippers)
    → SENSORS (verify)
```

LLMs can only consume text tokens. Every sensor reading — LIDAR point clouds, camera frames, joint encoder values, IMU data — must be translated into text descriptions before the LLM can reason about the physical world. This repository provides the sensor-to-text pipeline, the actuator command protocol, and the spatial reasoning abstractions that make this possible.

## Repository Contents

- `src/` — Full source: agent core, tool runtime, streaming provider, context management, Ink CLI UI, shell controller
- `src/robotics/` — Sensor-to-text pipeline, actuator protocol, spatial reasoning
- `agents/` — Robotics control agent rulebook
- `scripts/` — Build tooling and runtime scripts
- `test/` — Test suite

## Running

```bash
npm install
npm run build
npm link
vigil --key sk-...
```

## License

MIT
