import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-base px-6 text-center">
      <p className="text-[15px] text-primary">这里没有内容</p>
      <p className="mt-1 text-xs text-tertiary">地址可能写错了，或者内容已经被归档。</p>
      <Link to="/" className="mt-5 text-[13px] text-brand hover:text-brand-hover">
        回到首页
      </Link>
    </div>
  );
}
