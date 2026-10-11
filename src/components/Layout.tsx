import type { ReactNode } from 'react'
import Navbar from './Navbar'
import Footer from './Footer'

/** 单页布局：Navbar（sticky）+ 内容 + Footer */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div id="top" className="min-h-[100dvh] flex flex-col">
      <Navbar />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  )
}
