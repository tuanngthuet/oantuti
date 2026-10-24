import { NextResponse } from 'next/server';
const messages: Record<string,string> = {
  TRIAL_QUOTA_EXCEEDED:'Bạn đã dùng hết 10 trận thách đấu hôm nay. Hạn mức đặt lại lúc 00:00 giờ Việt Nam.',
  PUBLICATION_IRREVERSIBLE:'Agent đã public không thể chuyển lại riêng tư.',
  FEATURE_RETIRED:'Chức năng gửi lời thách đấu đã được thay bằng thách đấu riêng tư.',
  SCOPE_CHANGED:'Tư cách thi đấu đã thay đổi ở phiên khác. Hãy tải lại trang, kiểm tra cá nhân/team trước khi nộp code.',
  FORBIDDEN:'Bạn không có quyền thực hiện thao tác này.', ALREADY_IN_TEAM:'Người chơi đã thuộc một team. Phải rời đội trước khi được mời.',
  TEAM_FULL:'Team đã đủ 3 thành viên.', CREATOR_CANNOT_LEAVE:'Người tạo luôn là trưởng đội và không thể rời hoặc bị xóa. Chỉ admin được giải thể đội.',
  TEAM_NOT_RECRUITING:'Team hiện không nhận yêu cầu gia nhập.',
  JOIN_REQUEST_EXISTS:'Bạn đã gửi yêu cầu vào team này. Hãy chờ trưởng đội phản hồi.',
  JOIN_REQUEST_NOT_FOUND:'Không tìm thấy yêu cầu gia nhập.',
  JOIN_REQUEST_EXPIRED:'Yêu cầu đã hết hạn hoặc đã được xử lý.',
  TEAM_NOT_FOUND:'Không tìm thấy team đang hoạt động.', TEAM_ARCHIVED:'Team đã được giải thể.', USER_NOT_FOUND:'Không tìm thấy người chơi.',
  INVALID_TEAM_NAME:'Tên team phải có từ 1 đến 30 ký tự.', INVITATION_NOT_FOUND:'Không tìm thấy lời mời thuộc quyền của bạn.',
  INVITATION_EXPIRED:'Lời mời đã hết hạn hoặc đã được xử lý.', INVITATION_EXISTS:'Đã có lời mời đang chờ với người chơi/agent này.',
  AGENT_NOT_FOUND:'Không tìm thấy agent.', AGENT_INACTIVE:'Agent không còn hoạt động ở tư cách hiện tại.', SAME_PARTICIPANT:'Không thể đấu với agent cùng cá nhân/team.', INVALID_ACTION:'Thao tác không hợp lệ.',
};
export function teamError(error: unknown) {
  const message=error instanceof Error ? error.message : String(error);
  const code=Object.keys(messages).find(key=>message.includes(key));
  if (!code) { console.error('Team operation failed',error); return NextResponse.json({error:'Không thể xử lý yêu cầu team.'},{status:500}); }
  return NextResponse.json({error:messages[code],code},{status:code==='TRIAL_QUOTA_EXCEEDED'?429:code==='FEATURE_RETIRED'?410:code==='FORBIDDEN'?403:code.endsWith('NOT_FOUND')?404:code.startsWith('INVALID')?400:409});
}
export function validId(value: unknown): value is number { return typeof value==='number' && Number.isSafeInteger(value) && value>0; }
export function isObject(value: unknown): value is Record<string,unknown> { return !!value && typeof value==='object' && !Array.isArray(value); }
