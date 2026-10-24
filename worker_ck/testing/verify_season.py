"""Re-run all public official replays against the five frozen engines, without database writes."""
import importlib
import json
from pathlib import Path
import sys

NAMES = ['round_16','quarterfinal','semifinal','final','third_place']


def verify(bundle_path, records_path):
    bundle = json.loads(Path(bundle_path).read_text())
    records = json.loads(Path(records_path).read_text())
    assert bundle['format'] == 'ott-finals-bundle-v2'
    assert len(records) == 32
    actual_moves = 0
    outcomes = {'agent1':0,'agent2':0,'draw':0}
    for record in records:
        metadata = record['game']
        game_class = importlib.import_module('worker_ck.'+NAMES[metadata['round']-1]+'.engine').FinalsGame
        game = game_class(metadata['round_rules'])
        assert game.snapshot()['display'] == metadata['initial_state']
        for n, move in enumerate(record['moves'],1):
            assert not game.outcome, 'Moves after terminal state'
            assert move['move_number'] == n
            generated = game.step(move)
            for key, value in generated.items():
                assert move[key] == value, (metadata['id'],n,key)
            assert game.snapshot()['display'] == move['display'], (metadata['id'],n,'display')
        assert game.outcome == metadata['outcome'], metadata['id']
        assert game.reason == metadata['reason'], metadata['id']
        assert game.move_count == metadata['move_count']
        actual_moves += game.move_count
        outcomes[game.outcome] += 1
    print(json.dumps({'replays_verified':len(records),'legal_moves_verified':actual_moves,'outcomes':outcomes}))


if __name__ == '__main__':
    verify(sys.argv[1],sys.argv[2])
