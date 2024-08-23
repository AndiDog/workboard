import classes from './Spinner.module.css';
import { Component } from 'preact';

export default class Spinner extends Component {
  render = () => <div className={classes.ldsDualRing}></div>;
}
