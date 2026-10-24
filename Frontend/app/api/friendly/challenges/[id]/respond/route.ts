import {NextResponse} from 'next/server';
function retired(){return NextResponse.json({error:'Chức năng gửi lời thách đấu đã được thay bằng thách đấu riêng tư.',code:'FEATURE_RETIRED'},{status:410});}
export const GET=retired;
export const POST=retired;
