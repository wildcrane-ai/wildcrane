import './startup'
import { hostOf, main } from './plugin'

void main(hostOf(process.argv[2], process.env))
