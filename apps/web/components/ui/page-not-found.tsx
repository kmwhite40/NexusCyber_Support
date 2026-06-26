'use client';
// Vendored 21st.dev animated 404 page. Adapted for Next.js (next/navigation instead
// of react-router) and made self-contained: the stick figures are inline SVG data
// URIs rather than external GitHub-hosted images (no runtime egress — gov-safe).
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Home, Compass } from 'lucide-react';
import { Button } from '@/components/ui/primitives';

// Inline stick figure (black, on the white expanding circle field).
const STICK = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 100">
    <g stroke="black" stroke-width="4" stroke-linecap="round" fill="none">
      <circle cx="25" cy="14" r="9" fill="black" stroke="none"/>
      <line x1="25" y1="23" x2="25" y2="60"/>
      <line x1="25" y1="34" x2="9" y2="46"/>
      <line x1="25" y1="34" x2="41" y2="46"/>
      <line x1="25" y1="60" x2="11" y2="86"/>
      <line x1="25" y1="60" x2="39" y2="86"/>
    </g>
  </svg>`,
)}`;

export default function NotFoundPage() {
  return (
    <div className="w-full h-screen bg-bg overflow-x-hidden flex justify-center items-center relative">
      <MessageDisplay />
      <CharactersAnimation />
      <CircleAnimation />
    </div>
  );
}

function MessageDisplay() {
  const router = useRouter();
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 1200);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="absolute flex flex-col justify-center items-center w-[90%] h-[90%] z-[100]">
      <div className={`flex flex-col items-center text-center transition-opacity duration-500 ${isVisible ? 'opacity-100' : 'opacity-0'}`}>
        <Compass aria-hidden className="mb-4 h-12 w-12 text-bg" strokeWidth={1.75} />
        <div className="text-[35px] font-semibold text-bg leading-tight">Page Not Found</div>
        <div className="text-[80px] font-bold text-bg leading-none my-2">404</div>
        <div className="text-[15px] w-1/2 min-w-[40%] text-center text-bg/70">
          The page you are looking for might have been removed, had its name changed, or is
          temporarily unavailable.
        </div>
        <div className="flex flex-wrap justify-center gap-4 mt-10">
          <Button variant="outline" size="lg" onClick={() => router.back()}>
            <ArrowLeft aria-hidden className="h-4 w-4" strokeWidth={1.75} />
            Go Back
          </Button>
          <Button variant="default" size="lg" onClick={() => router.push('/')}>
            <Home aria-hidden className="h-4 w-4" strokeWidth={1.75} />
            Go Home
          </Button>
        </div>
      </div>
    </div>
  );
}

type StickFigure = {
  top?: string;
  bottom?: string;
  src: string;
  transform?: string;
  speedX: number;
  speedRotation?: number;
};

function CharactersAnimation() {
  const charactersRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stickFigures: StickFigure[] = [
      { top: '0%', src: STICK, transform: 'rotateZ(-90deg)', speedX: 1500 },
      { top: '10%', src: STICK, speedX: 3000, speedRotation: 2000 },
      { top: '20%', src: STICK, speedX: 5000, speedRotation: 1000 },
      { top: '25%', src: STICK, speedX: 2500, speedRotation: 1500 },
      { top: '35%', src: STICK, speedX: 2000, speedRotation: 300 },
      { bottom: '5%', src: STICK, speedX: 0 },
    ];

    const container = charactersRef.current;
    if (container) container.innerHTML = '';

    stickFigures.forEach((figure, index) => {
      const stick = document.createElement('img');
      stick.classList.add('characters');
      stick.style.position = 'absolute';
      stick.style.width = '18%';
      stick.style.height = '18%';
      if (figure.top) stick.style.top = figure.top;
      if (figure.bottom) stick.style.bottom = figure.bottom;
      stick.src = figure.src;
      if (figure.transform) stick.style.transform = figure.transform;
      container?.appendChild(stick);

      if (index === 5) return;
      stick.animate([{ left: '100%' }, { left: '-20%' }], { duration: figure.speedX, easing: 'linear', fill: 'forwards' });
      if (index === 0) return;
      if (figure.speedRotation) {
        stick.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(-360deg)' }], {
          duration: figure.speedRotation,
          iterations: Infinity,
          easing: 'linear',
        });
      }
    });

    return () => {
      if (container) container.innerHTML = '';
    };
  }, []);

  return <div ref={charactersRef} className="absolute w-[99%] h-[95%]" />;
}

interface Circulo {
  x: number;
  y: number;
  size: number;
}

function CircleAnimation() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestIdRef = useRef<number>();
  const timerRef = useRef(0);
  const circulosRef = useRef<Circulo[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const initArr = () => {
      circulosRef.current = [];
      for (let index = 0; index < 300; index++) {
        const randomX =
          Math.floor(Math.random() * (canvas.width * 3 - canvas.width * 1.2 + 1)) + canvas.width * 1.2;
        const randomY =
          Math.floor(Math.random() * (canvas.height - (canvas.height * -0.2 + 1))) + canvas.height * -0.2;
        const size = canvas.width / 1000;
        circulosRef.current.push({ x: randomX, y: randomY, size });
      }
    };

    const draw = () => {
      const context = canvas.getContext('2d');
      if (!context) return;
      timerRef.current++;
      context.setTransform(1, 0, 0, 1, 0, 0);
      const distanceX = canvas.width / 80;
      const growthRate = canvas.width / 1000;
      context.fillStyle = 'white';
      context.clearRect(0, 0, canvas.width, canvas.height);

      circulosRef.current.forEach((circulo) => {
        context.beginPath();
        if (timerRef.current < 65) {
          circulo.x = circulo.x - distanceX;
          circulo.size = circulo.size + growthRate;
        }
        if (timerRef.current > 65 && timerRef.current < 500) {
          circulo.x = circulo.x - distanceX * 0.02;
          circulo.size = circulo.size + growthRate * 0.2;
        }
        context.arc(circulo.x, circulo.y, circulo.size, 0, 360);
        context.fill();
      });

      if (timerRef.current > 500) {
        if (requestIdRef.current) cancelAnimationFrame(requestIdRef.current);
        return;
      }
      requestIdRef.current = requestAnimationFrame(draw);
    };

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    timerRef.current = 0;
    initArr();
    draw();

    const handleResize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      timerRef.current = 0;
      if (requestIdRef.current) cancelAnimationFrame(requestIdRef.current);
      initArr();
      draw();
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (requestIdRef.current) cancelAnimationFrame(requestIdRef.current);
    };
  }, []);

  return <canvas ref={canvasRef} className="w-full h-full" />;
}
