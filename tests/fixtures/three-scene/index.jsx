// Крошечная 3D-сцена для рендер-теста #150 (авторская, MIT): куб вращается только от номера кадра.
import React from 'react';
import { Composition, interpolate, registerRoot, useCurrentFrame, useVideoConfig } from 'remotion';
import { ThreeCanvas } from '@remotion/three';

const Cube = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const turn = interpolate(frame, [0, 30], [0, Math.PI]);
  return (
    <ThreeCanvas width={width} height={height} style={{ backgroundColor: '#101418' }} camera={{ fov: 40, position: [0, 0, 9] }}>
      <ambientLight intensity={0.4} />
      <directionalLight position={[3, 4, 5]} intensity={2} />
      <mesh rotation={[turn * 0.6, turn, 0]}>
        <boxGeometry args={[2, 2, 2]} />
        <meshStandardMaterial color="#ff6a3d" roughness={0.35} metalness={0.2} />
      </mesh>
    </ThreeCanvas>
  );
};

const Root = () => <Composition id="Scene3d" component={Cube} durationInFrames={30} fps={30} width={270} height={480} />;
registerRoot(Root);
