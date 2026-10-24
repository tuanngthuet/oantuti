"""Versioned finals rules; future versions must not mutate this implementation."""
from .board import OTTGameEngine, Move
import hashlib
import json

ENGINE_VERSION = 'ott-finals-v1'
RULES = {'engine_version': ENGINE_VERSION, 'max_moves': 150, 'repetition': 3}


def position_key(state):
    position = (state.current_turn, [(p.player, p.type) if p else None for row in state.board for p in row])
    return hashlib.sha256(json.dumps(position,separators=(',',':')).encode()).hexdigest()


class FinalsGame:
    def __init__(self, rules=None):
        self.rules = dict(rules or RULES)
        if self.rules != RULES:
            raise ValueError('Unsupported finals engine/rules version')
        self.engine = OTTGameEngine()
        self.positions = {position_key(self.engine.state): 1}
        self.outcome = None
        self.reason = ''

    @property
    def current_player(self):
        return self.engine.state.current_turn

    @property
    def move_count(self):
        return self.engine.state.move_count

    def observation(self):
        return {**self.engine.get_observation(), 'finals': {'engine_version': ENGINE_VERSION, 'terrain': [], 'bonus_cells': [], 'scores': {'1': 0, '2': 0}}}

    def step(self, action):
        if self.outcome:
            raise ValueError('Game already finished')
        if not isinstance(action, dict):
            raise ValueError('Agent must return a move object')
        keys = ('from_col', 'from_row', 'to_col', 'to_row')
        if 'from_pos' in action and 'to_pos' in action:
            def parse(value):
                if not isinstance(value, str) or len(value) != 2 or value[0] not in 'abcdefghi' or value[1] not in '123456789':
                    raise ValueError('Invalid position')
                return ord(value[0])-97, int(value[1])-1
            fc, fr = parse(action['from_pos']); tc, tr = parse(action['to_pos'])
            action = dict(zip(keys, (fc, fr, tc, tr)))
        if any(type(action.get(k)) is not int or not 0 <= action[k] <= 8 for k in keys):
            raise ValueError('Invalid move coordinates')
        state = self.engine.state
        piece = state.board[action['from_row']][action['from_col']]
        player = state.current_turn
        result = self.engine.apply_move(Move(**{k: action[k] for k in keys}))
        if not result['success']:
            raise ValueError(result.get('error', 'Illegal move'))
        key = position_key(state)
        self.positions[key] = self.positions.get(key, 0)+1
        if result['game_over']:
            self.outcome = 'agent1' if state.winner == 1 else 'agent2'
            self.reason = state.win_reason
        elif self.positions[key] >= self.rules['repetition']:
            self.outcome = 'draw'; self.reason = 'Hòa: lặp thế cờ lần thứ 3.'
        elif state.move_count >= self.rules['max_moves']:
            self.outcome = 'draw'; self.reason = 'Đạt giới hạn 150 nước.'
        if self.outcome:
            state.game_over = True
            state.win_reason = self.reason
        captured = result.get('captured')
        return {**{k: action[k] for k in keys}, 'move_number': state.move_count, 'player': player,
                'piece_type': piece.type, 'captured_type': captured['type'] if captured else None}

    def snapshot(self):
        return {'display': {'board': self.engine.get_observation()['board'], 'terrain': [], 'bonus_cells': [], 'scores': {'1': 0, '2': 0}}, 'engine': self.engine.get_state_dict(), 'positions': self.positions, 'outcome': self.outcome, 'reason': self.reason}
