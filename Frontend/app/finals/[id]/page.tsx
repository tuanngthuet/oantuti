import FinalsOverview from '@/components/FinalsOverview';
export default async function Page({params}:{params:Promise<{id:string}>}){return <FinalsOverview initialId={(await params).id}/>;}
