import { useEffect } from 'react';
import { motion, useReducedMotion, useSpring, useTransform } from 'framer-motion';

/** Number that springs to its new value (stiffness 120, damping 20). */
export function AnimatedNumber({ value, format, className, style }: { value: number; format: (n: number) => string; className?: string; style?: React.CSSProperties }) {
  const reduced = useReducedMotion();
  const spring = useSpring(value, { stiffness: 120, damping: 20 });
  useEffect(() => {
    if (reduced) spring.jump(value);
    else spring.set(value);
  }, [value, reduced, spring]);
  const text = useTransform(spring, format);
  return (
    <motion.span className={className} style={style}>
      {text}
    </motion.span>
  );
}
