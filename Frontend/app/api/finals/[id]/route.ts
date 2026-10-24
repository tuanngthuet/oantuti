import {NextResponse} from 'next/server';
import {editionData,finalsError} from '@/lib/finals';
export const dynamic='force-dynamic';
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
 const id=Number((await params).id);if(!Number.isSafeInteger(id)||id<1)return NextResponse.json({error:'ID không hợp lệ.'},{status:400});
 try{const data=await editionData(id);return NextResponse.json(data??{error:'Không tìm thấy giải.'},{status:data?200:404});}catch(error){return finalsError(error);}
}
