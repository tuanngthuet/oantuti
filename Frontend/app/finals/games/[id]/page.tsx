import FinalsReplay from '@/components/FinalsReplay';
export default async function Page({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{admin?:string}>}){return <FinalsReplay id={(await params).id} admin={(await searchParams).admin==='1'}/>;}
